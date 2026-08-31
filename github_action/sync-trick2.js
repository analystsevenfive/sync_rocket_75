/*************************************************
 * SYNC TRICK2 — Node.js port ของ syncTrick2() (trick2.js)
 *
 * ทดสอบผ่านแล้วบนชีท "Trick2 (Test)" — Apps Script
 * trigger เดิมปิดไปแล้ว จึงสลับมาเขียนชีท "Trick2" จริง
 *
 * มี prune แล้ว (ต่างจาก Apps Script เดิม) — แก้ปัญหาเดิม
 * ที่ต้อง map subId->ticketNo ก่อนถึงจะรู้ว่าแถวไหนควรลบ
 * (Trick2 คีย์ด้วย Ticket No ไม่ใช่ subId ตัวเลข) โดยอ่าน
 * mapping นี้จากชีท Tickets ที่ sync-tickets.js เก็บไว้แล้ว
 * แทนที่จะต้อง fetch รายละเอียดตั๋วทุกใบซ้ำอีกรอบ
 *************************************************/

const rocket = require('./lib/rocket-client');
const sheetsLib = require('./lib/sheets-client');

const TICKETS_SHEET_NAME = 'Tickets';
const TRICK2_SHEET_NAME = 'Trick2';
const CLOSED_REPAIR_RESULT = 'ซ่อมเรียบร้อย';

const PARENT_CONCURRENCY = 30;
const SUB_CONCURRENCY = 30;

// ตำแหน่งคอลัมน์ใน "Tickets" (ต้องตรงกับ
// TICKET_HEADERS ใน sync-tickets.js เสมอ)
const TICKETS_TICKET_ID_COL = 1;
const TICKETS_TICKET_NO_COL = 4;
const TICKETS_REPAIR_RESULT_COL = 26;

const TRICK2_HEADERS = [
  'Received Date', 'Work Order No.', 'Job No. (BK)', 'Customer Name', 'Technician Name',
  'Team', 'Total', 'Remarks', 'Rocket URL', 'Last Sync'
];

const TRICK2_JOBNO_COL = 3;



function trick2ToRow(d, lastSync) {
  return [
    d.reportDate, '', d.ticketNo, d.customer, d.technicians,
    d.team, '', d.note, d.url, lastSync
  ];
}



async function main() {

  console.log('========== TRICK2 SYNC (Node.js / GitHub Actions) ==========');

  const auth = await rocket.rocketLogin();
  console.log('LOGIN OK');

  const range = rocket.computeLast3MonthsRangeBangkok();
  console.log('ช่วงวันที่: ' + range.start + ' - ' + range.end);

  // ==========================================
  // 1. PARENT TICKETS
  // ==========================================

  const parentHtml = await rocket.getParentTicketHtml(auth, range.start, range.end);
  const parentIds = rocket.extractParentTicketIds(parentHtml);
  console.log('PARENT TICKETS: ' + parentIds.length);

  // getTable.php อาจตอบ 200 กลับมาแบบไม่ใช่ตารางจริง (session
  // สะดุด) ทำให้ extractParentTicketIds คืน [] เงียบๆ — abort
  // ก่อนดีกว่าเขียนสถานะผิดพลาดทับของเดิม
  if (parentIds.length === 0) {
    throw new Error('พบ 0 parent ticket — น่าจะเป็น fetch/parse ผิดพลาดชั่วคราว ไม่ใช่ข้อมูลจริง');
  }

  // ==========================================
  // 2. SUB TICKETS + team/technician info ต่อ parent
  // ==========================================

  const checkRepairResults = await rocket.mapConcurrent(parentIds, PARENT_CONCURRENCY, async function(parentId) {
    const html = await rocket.getCheckRepairHtml(parentId, auth);
    return {
      ids: rocket.extractCheckRepairIds(html),
      info: rocket.extractCheckRepairInfo(html)
    };
  });

  let subIds = [];
  let infoMap = {};

  checkRepairResults.forEach(function(r, i) {
    if (r && r.__error) {
      console.log('ERROR Parent ' + parentIds[i] + ': ' + r.__error);
    } else if (r) {
      subIds = subIds.concat(r.ids);
      Object.assign(infoMap, r.info);
    }
  });
  subIds = [...new Set(subIds)];
  console.log('SUB TICKETS: ' + subIds.length);

  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new Error('ไม่พบ SPREADSHEET_ID ใน environment variables');
  }
  const sheets = await sheetsLib.getSheetsClient();

  // ต่างจาก SpreadsheetApp — Sheets API ไม่สร้างแท็บ
  // ใหม่ให้อัตโนมัติ ต้องเช็ค+สร้างเองก่อนเสมอ
  const sheetId = await sheetsLib.ensureSheetExists(sheets, spreadsheetId, TRICK2_SHEET_NAME);

  // ขยาย grid ล่วงหน้าตั้งแต่ตรงนี้ (ก่อน fetch รายละเอียด
  // ตั๋วซึ่งกินเวลาหลายนาที) กัน error "exceeds grid limits"
  // จาก eventual consistency ถ้าขยาย+เขียนติดกันเร็วไป
  await sheetsLib.ensureGridSize(sheets, spreadsheetId, sheetId, subIds.length + 1000);

  // ==========================================
  // 3. PRUNE ticket ที่หลุดช่วงวันที่ปัจจุบัน (อ้างอิง
  // subId -> Ticket No จากชีท Tickets เพราะ Trick2 คีย์
  // ด้วย Ticket No ไม่ใช่ subId ตัวเลขโดยตรง)
  // ==========================================

  const idToTicketNoMap = await sheetsLib.getIdToValueMap(
    sheets, spreadsheetId, TICKETS_SHEET_NAME, TICKETS_TICKET_ID_COL, TICKETS_TICKET_NO_COL
  );

  const validTicketNos = new Set();
  let unmappedCount = 0;
  subIds.forEach(function(id) {
    const ticketNo = idToTicketNoMap[String(id)];
    if (ticketNo) {
      validTicketNos.add(ticketNo);
    } else {
      unmappedCount++;
    }
  });

  if (unmappedCount > 0) {
    console.log(unmappedCount + ' ใบยังไม่มี Ticket No ในชีท Tickets (อาจยังไม่ถูก sync มา)');
  }

  // กันกรณีชีท Tickets ยังไม่มีข้อมูลพอ (เช่นไม่เคยรันมา
  // ก่อน หรือรันไม่สำเร็จ) จน mapping ได้น้อยผิดปกติ — ถ้า
  // prune ไปตอนนั้นเสี่ยงลบของดีทิ้งเพราะ map ไม่ครบ ไม่ใช่
  // เพราะตั๋วหลุดช่วงวันที่จริง
  const mappedRatio = subIds.length === 0 ? 1 : validTicketNos.size / subIds.length;
  if (mappedRatio < 0.9) {
    console.log(
      'map ได้แค่ ' + (mappedRatio * 100).toFixed(0) +
      '% ของตั๋วทั้งหมด — ข้าม prune รอบนี้ (เผื่อชีท Tickets ยังไม่ทันอัพเดต) กันลบผิด'
    );
  } else {
    const prunedCount = await sheetsLib.pruneStaleRows(
      sheets, spreadsheetId, sheetId, TRICK2_SHEET_NAME, TRICK2_JOBNO_COL, validTicketNos
    );
    if (prunedCount > 0) {
      console.log('ลบ ' + prunedCount + ' แถวที่หลุดช่วงวันที่ sync ปัจจุบันแล้ว');
    }
  }

  // ต้องสร้าง index ตอนนี้ (หลัง prune แล้ว ก่อน skip) เพื่อ
  // เอาไปเช็คในขั้นถัดไปว่าตั๋วที่ปิดงานแล้วมีแถวใน Trick2
  // อยู่จริงไหม — ไม่ใช่แค่รอไปสร้างตอน batchUpsert เหมือนเดิม
  const ctx = await sheetsLib.ensureSheetAndBuildIndex(sheets, spreadsheetId, TRICK2_SHEET_NAME, TRICK2_HEADERS, TRICK2_JOBNO_COL);

  // ==========================================
  // 4. SKIP ticket ที่ปิดงานแล้ว "และ" มีแถวใน Trick2 อยู่แล้ว
  // ==========================================
  //
  // เดิม skip แค่เพราะปิดงานแล้วอย่างเดียว — พลาดเคสที่ครั้ง
  // แรกที่พยายาม fetch ตั๋วนี้เข้า Trick2 ล้มเหลว (เช่น
  // network hiccup ชั่วคราว) แล้วตั๋วดันปิดงานไปแล้วก่อนจะ
  // retry สำเร็จ — ตั๋วนั้นจะไม่มีแถวใน Trick2 เลยตลอดไป
  // (ต่างจาก Tickets ที่อย่างน้อยยังมีแถวเปล่าๆ ให้เห็น) ต้อง
  // เช็คเพิ่มว่ามีแถวอยู่แล้วจริงไหม ไม่ใช่แค่ปิดงานหรือยัง

  const closedIds = await sheetsLib.getClosedIdsFromSheet(
    sheets, spreadsheetId, TICKETS_SHEET_NAME,
    TICKETS_TICKET_ID_COL, TICKETS_REPAIR_RESULT_COL, CLOSED_REPAIR_RESULT
  );

  const pendingSubs = subIds.filter(function(id) {
    if (!closedIds.has(String(id))) {
      return true;
    }
    const ticketNo = idToTicketNoMap[String(id)];
    const alreadyInTrick2 = Boolean(ticketNo && ctx.index[ticketNo]);
    return !alreadyInTrick2;
  });

  const skippedCount = subIds.length - pendingSubs.length;
  if (skippedCount > 0) {
    console.log(
      'ข้าม ' + skippedCount + ' ใบเพราะปิดงานแล้วและมีแถวใน Trick2 อยู่แล้ว — เหลือต้อง fetch ' +
      pendingSubs.length + ' ใบ จากทั้งหมด ' + subIds.length + ' ใบ'
    );
  }

  // ==========================================
  // 5. FETCH DETAIL + UPSERT
  // ==========================================

  const detailResults = await rocket.mapConcurrent(pendingSubs, SUB_CONCURRENCY, async function(subId) {
    const html = await rocket.getTicketDetailHtml(subId, auth);
    const ticket = rocket.parseTicketDetail(html, subId);
    // เหมือนใน sync-tickets.js — กันหน้าที่ไม่ใช่ ticket detail
    // จริง (session glitch/rate-limit) ไม่ให้เขียนเป็นแถวว่าง
    if (!ticket.ticketNo && !ticket.status) {
      throw new Error('หน้าที่ได้ไม่ใช่ ticket detail จริง (parse ไม่สำเร็จ)');
    }
    const info = infoMap[String(subId)] || {};
    ticket.team = info.team || '';
    ticket.technicians = info.technicians || ticket.technician || '';
    return ticket;
  });

  const lastSync = rocket.formatDateTimeBangkok(new Date());

  const rows = [];
  detailResults.forEach(function(r, i) {
    if (r && r.__error) {
      console.log('ERROR SubTicket ' + pendingSubs[i] + ': ' + r.__error);
    } else if (r) {
      rows.push({ key: String(r.ticketNo), row: trick2ToRow(r, lastSync) });
    }
  });

  await sheetsLib.batchUpsert(sheets, spreadsheetId, sheetId, TRICK2_SHEET_NAME, TRICK2_HEADERS, ctx, rows);

  console.log('เขียนแล้ว ' + rows.length + '/' + pendingSubs.length);
  console.log('DONE');

}

main().catch(function(err) {
  console.error('Sync ล้มเหลว:', err);
  process.exit(1);
});
