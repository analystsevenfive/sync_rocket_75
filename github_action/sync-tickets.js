/*************************************************
 * SYNC TICKETS — Node.js port ของ syncRocket75()
 * (trick.js) รวม incremental skip-if-closed + prune
 * ที่เพิ่งทำบน Apps Script ด้วย
 *
 * เขียนลงชีท "Tickets (Test)" ก่อน (ไม่แตะชีท "Tickets"
 * จริงที่ Apps Script ยัง sync อยู่) จนกว่าจะเทียบผล
 * แล้วมั่นใจว่าพอร์ตมาถูกต้อง
 *************************************************/

const rocket = require('./lib/rocket-client');
const sheetsLib = require('./lib/sheets-client');

const TICKETS_SHEET_NAME = 'Tickets (Test)';
const CLOSED_REPAIR_RESULT = 'ซ่อมเรียบร้อย';

const PARENT_CONCURRENCY = 30;
const SUB_CONCURRENCY = 30;

const TICKET_HEADERS = [
  'Ticket ID', 'Parent Ticket ID', 'Parent Ticket No', 'Ticket No', 'Status', 'Appointment',
  'Report Date', 'Customer', 'Branch', 'Contact', 'Phone',
  'Problem Reported', 'Work Description', 'Special Condition', 'Note', 'Machine Location',
  'Product Code', 'Product Name', 'Power Type', 'Serial', 'Warranty',
  'Start Time', 'End Time', 'Duration Min', 'Time Recorder',
  'Repair Result', 'Customer Symptom', 'Cause Found', 'Solution', 'Repair Note',
  'Part Failure Cause', 'Technician',
  'URL', 'Last Sync'
];

const TICKET_ID_COL = 1;
const REPAIR_RESULT_COL = TICKET_HEADERS.indexOf('Repair Result') + 1;



// เหมือน forceTextIfNumeric_ ใน trick.js — กันเบอร์โทร
// เลข 0 นำหน้าหายตอน USER_ENTERED ตีความเป็น number
function forceTextIfNumeric(value) {
  if (value === null || value === undefined || value === '') {
    return value;
  }
  const str = String(value);
  return /^\d+$/.test(str) ? "'" + str : str;
}



function ticketToRow(d, lastSync) {
  return [
    d.ticketId, d.parentTicketId, d.parentTicketNo, d.ticketNo, d.status, d.appointment,
    d.reportDate, d.customer, d.branch, d.contact, forceTextIfNumeric(d.phone),
    d.problem, d.workDescription, d.specialCondition, d.note, d.machineLocation,
    d.productCode, d.productName, d.powerType, d.serial, d.warranty,
    d.startTime, d.endTime, d.duration, d.timeRecorder,
    d.repairResult, d.customerSymptom, d.causeFound, d.solution, d.repairNote,
    d.partFailureCause, d.technician,
    d.url, lastSync
  ];
}



// ใช้ตัวช่วยกลางใน sheets-client.js (ใช้ร่วมกับ
// sync-trick2.js ได้ เพราะทั้งคู่อ้างอิงชีท Tickets
// เดียวกันด้วยเงื่อนไขเดียวกัน)
function getClosedSubTicketIds(sheets, spreadsheetId) {
  return sheetsLib.getClosedIdsFromSheet(
    sheets, spreadsheetId, TICKETS_SHEET_NAME,
    TICKET_ID_COL, REPAIR_RESULT_COL, CLOSED_REPAIR_RESULT
  );
}



async function main() {

  console.log('========== TICKETS SYNC (Node.js / GitHub Actions) ==========');

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

  // getTable.php อาจตอบ HTTP 200 กลับมาแบบเนื้อหาไม่ใช่
  // ตารางจริง (session สะดุด) ทำให้ extractParentTicketIds
  // คืน [] แบบเงียบๆ โดยไม่ throw — ถ้าปล่อยผ่านไปจะทำให้
  // subIds ว่างเปล่า แล้ว pruneStaleRows (ด้านล่าง) เข้าใจว่า
  // ทุกแถวที่มีอยู่ "หลุดช่วงวันที่" แล้วลบทิ้งทั้งชีท —
  // ต้อง abort ทันทีถ้าเจอ 0 parent ticket แทนที่จะปล่อยให้
  // ทำงานต่อ
  if (parentIds.length === 0) {
    throw new Error('พบ 0 parent ticket — น่าจะเป็น fetch/parse ผิดพลาดชั่วคราว ไม่ใช่ข้อมูลจริง หยุดก่อนเพื่อกัน prune ลบข้อมูลทั้งชีทโดยไม่ตั้งใจ');
  }

  // ==========================================
  // 2. SUB TICKETS (checkrepair.php ต่อ parent)
  // ==========================================

  const checkRepairResults = await rocket.mapConcurrent(parentIds, PARENT_CONCURRENCY, async function(parentId) {
    const html = await rocket.getCheckRepairHtml(parentId, auth);
    return rocket.extractCheckRepairIds(html);
  });

  let subIds = [];
  checkRepairResults.forEach(function(r, i) {
    if (r && r.__error) {
      console.log('ERROR Parent ' + parentIds[i] + ': ' + r.__error);
    } else if (Array.isArray(r)) {
      subIds = subIds.concat(r);
    }
  });
  subIds = [...new Set(subIds)];
  console.log('SUB TICKETS: ' + subIds.length);

  // เหตุผลเดียวกับเช็ค parentIds ด้านบน — subIds ว่างคือ
  // สัญญาณผิดปกติ ต้อง abort ก่อนถึง prune ไม่ใช่ปล่อยผ่าน
  if (subIds.length === 0) {
    throw new Error('พบ 0 sub ticket ทั้งที่มี ' + parentIds.length + ' parent ticket — น่าจะเป็น fetch/parse ผิดพลาดชั่วคราว หยุดก่อนเพื่อกัน prune ลบข้อมูลทั้งชีทโดยไม่ตั้งใจ');
  }

  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new Error('ไม่พบ SPREADSHEET_ID ใน environment variables');
  }
  const sheets = await sheetsLib.getSheetsClient();

  // ต่างจาก SpreadsheetApp — Sheets API ไม่สร้างแท็บ
  // ใหม่ให้อัตโนมัติ ต้องเช็ค+สร้างเองก่อนเสมอ
  const sheetId = await sheetsLib.ensureSheetExists(sheets, spreadsheetId, TICKETS_SHEET_NAME);

  // ==========================================
  // 3. PRUNE ticket ที่หลุดช่วงวันที่ปัจจุบัน
  // ==========================================

  {
    const prunedCount = await sheetsLib.pruneStaleRows(
      sheets, spreadsheetId, sheetId, TICKETS_SHEET_NAME, TICKET_ID_COL, new Set(subIds)
    );
    if (prunedCount > 0) {
      console.log('ลบ ' + prunedCount + ' แถวที่หลุดช่วงวันที่ sync ปัจจุบันแล้ว');
    }
  }

  // ==========================================
  // 4. SKIP ticket ที่ปิดงานแล้ว (Repair Result = "ซ่อมเรียบร้อย")
  // ==========================================

  const closedIds = await getClosedSubTicketIds(sheets, spreadsheetId);
  const pendingSubs = subIds.filter(function(id) { return !closedIds.has(String(id)); });

  const skippedCount = subIds.length - pendingSubs.length;
  if (skippedCount > 0) {
    console.log(
      'ข้าม ' + skippedCount + ' ใบเพราะ Repair Result = "' + CLOSED_REPAIR_RESULT +
      '" อยู่แล้ว — เหลือต้อง fetch ' + pendingSubs.length + ' ใบ จากทั้งหมด ' + subIds.length + ' ใบ'
    );
  }

  // ==========================================
  // 5. FETCH DETAIL + UPSERT
  // ==========================================

  const detailResults = await rocket.mapConcurrent(pendingSubs, SUB_CONCURRENCY, async function(subId) {
    const html = await rocket.getTicketDetailHtml(subId, auth);
    const ticket = rocket.parseTicketDetail(html, subId);
    // ภายใต้ concurrency สูง บางครั้งเซิร์ฟเวอร์ตอบ HTTP 200
    // แต่เนื้อหาไม่ใช่หน้า ticket detail จริง (session sglitch/
    // rate-limit placeholder) — ticketNo/status ว่างพร้อมกันคือ
    // สัญญาณว่า parse ไม่สำเร็จ ต้องนับเป็น error ไม่ใช่เขียนแถวว่าง
    if (!ticket.ticketNo && !ticket.status) {
      throw new Error('หน้าที่ได้ไม่ใช่ ticket detail จริง (parse ไม่สำเร็จ)');
    }
    return ticket;
  });

  const lastSync = rocket.formatDateTimeBangkok(new Date());

  const rows = [];
  detailResults.forEach(function(r, i) {
    if (r && r.__error) {
      console.log('ERROR SubTicket ' + pendingSubs[i] + ': ' + r.__error);
    } else if (r) {
      rows.push({ key: String(r.ticketId), row: ticketToRow(r, lastSync) });
    }
  });

  const ctx = await sheetsLib.ensureSheetAndBuildIndex(sheets, spreadsheetId, TICKETS_SHEET_NAME, TICKET_HEADERS, TICKET_ID_COL);
  await sheetsLib.batchUpsert(sheets, spreadsheetId, TICKETS_SHEET_NAME, TICKET_HEADERS, ctx, rows);

  console.log('เขียนแล้ว ' + rows.length + '/' + pendingSubs.length);
  console.log('DONE');

}

main().catch(function(err) {
  console.error('Sync ล้มเหลว:', err);
  process.exit(1);
});
