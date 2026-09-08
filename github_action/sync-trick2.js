/*************************************************
 * SYNC TRICK2 — Node.js port ของ syncTrick2() (trick2.js)
 *
 * ซิงค์ข้อมูลลงชีท "Trick2" แบบ Full Fresh Sync
 * สดใหม่ทุกรอบ (ไม่ข้ามตั๋วที่ปิดงานแล้ว)
 * พร้อมแถบสรุปแถว 1 (ช่วงวันที่ + จำนวนรายการ)
 * และตรึง 2 แถวบนสุด (คง 10 คอลัมน์เดิมไว้)
 *************************************************/

const rocket = require('./lib/rocket-client');
const sheetsLib = require('./lib/sheets-client');

const TRICK2_SHEET_NAME = 'Trick2';

const PARENT_CONCURRENCY = 30;
const SUB_CONCURRENCY = 30;

const TRICK2_HEADERS = [
  'Received Date', 'Work Order No.', 'Job No. (BK)', 'Customer Name', 'Technician Name',
  'Team', 'Total', 'Remarks', 'Rocket URL', 'Last Sync'
];

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

  if (subIds.length === 0) {
    throw new Error('พบ 0 sub ticket ทั้งที่มี ' + parentIds.length + ' parent ticket — น่าจะเป็น fetch/parse ผิดพลาดชั่วคราว');
  }

  // ==========================================
  // 3. FETCH DETAIL (ทุกใบ ไม่ข้าม — sync สดใหม่ทุกรอบ)
  // ==========================================

  console.log('กำลังดึงรายละเอียดตั๋วทั้งหมด ' + subIds.length + ' ใบ (sync สดใหม่ทุกรายการ)...');
  const detailResults = await rocket.mapConcurrent(subIds, SUB_CONCURRENCY, async function(subId) {
    const html = await rocket.getTicketDetailHtml(subId, auth);
    const ticket = rocket.parseTicketDetail(html, subId);
    if (!ticket.ticketNo && !ticket.status) {
      throw new Error('หน้าที่ได้ไม่ใช่ ticket detail จริง (parse ไม่สำเร็จ)');
    }
    const info = infoMap[String(subId)] || {};
    ticket.team = info.team || '';
    ticket.technicians = info.technicians || ticket.technician || '';
    return ticket;
  });

  const validTickets = [];
  detailResults.forEach(function(r, i) {
    if (r && r.__error) {
      console.log('ERROR SubTicket ' + subIds[i] + ': ' + r.__error);
    } else if (r) {
      validTickets.push(r);
    }
  });

  // ==========================================
  // 4. บันทึกลง GOOGLE SHEETS ด้วย replaceSheetDataWithSummary
  // ==========================================

  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new Error('ไม่พบ SPREADSHEET_ID ใน environment variables');
  }
  const sheets = await sheetsLib.getSheetsClient();
  const sheetId = await sheetsLib.ensureSheetExists(sheets, spreadsheetId, TRICK2_SHEET_NAME);

  const lastSync = rocket.formatDateTimeBangkok(new Date());
  const rows = validTickets.map(function(t) {
    return trick2ToRow(t, lastSync);
  });

  const summaryText = 'ช่วงข้อมูล ' + range.start + ' - ' + range.end + ' | จำนวน ' + rows.length.toLocaleString('en-US') + ' รายการ';
  await sheetsLib.replaceSheetDataWithSummary(sheets, spreadsheetId, sheetId, TRICK2_SHEET_NAME, summaryText, TRICK2_HEADERS, rows);

  console.log('เขียนลงชีท \'' + TRICK2_SHEET_NAME + '\' สำเร็จ: ' + rows.length + ' แถว (' + summaryText + ')');
  console.log('DONE');

}

main().catch(function(err) {
  console.error('Sync ล้มเหลว:', err);
  process.exit(1);
});
