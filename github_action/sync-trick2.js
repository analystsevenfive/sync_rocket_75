/*************************************************
 * SYNC TRICK2 — Node.js port ของ syncTrick2() (trick2.js)
 *
 * เขียนลงชีท "Trick2 (Test)" ก่อน — ไม่แตะ "Trick2" จริง
 * จนกว่าจะเทียบผลแล้วมั่นใจ
 *
 * ข้อจำกัดเดียวกับฝั่ง Apps Script: ยังไม่มี prune
 * (ต้อง map subId->ticketNo ก่อนถึงจะรู้ว่าแถวไหนควรลบ
 * ดู ROCKET75-SYNC-NOTES.md ข้อ 7 สำหรับเหตุผลเต็มๆ)
 *************************************************/

const rocket = require('./lib/rocket-client');
const sheetsLib = require('./lib/sheets-client');

const TICKETS_SHEET_NAME = 'Tickets (Test)';
const TRICK2_SHEET_NAME = 'Trick2 (Test)';
const CLOSED_REPAIR_RESULT = 'ซ่อมเรียบร้อย';

const PARENT_CONCURRENCY = 30;
const SUB_CONCURRENCY = 30;

// ตำแหน่งคอลัมน์ใน "Tickets (Test)" (ต้องตรงกับ
// TICKET_HEADERS ใน sync-tickets.js เสมอ)
const TICKETS_TICKET_ID_COL = 1;
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
  await sheetsLib.ensureSheetExists(sheets, spreadsheetId, TRICK2_SHEET_NAME);

  // ==========================================
  // 3. SKIP ticket ที่ปิดงานแล้ว (อ้างอิงชีท Tickets)
  // ==========================================

  const closedIds = await sheetsLib.getClosedIdsFromSheet(
    sheets, spreadsheetId, TICKETS_SHEET_NAME,
    TICKETS_TICKET_ID_COL, TICKETS_REPAIR_RESULT_COL, CLOSED_REPAIR_RESULT
  );

  const pendingSubs = subIds.filter(function(id) { return !closedIds.has(String(id)); });
  const skippedCount = subIds.length - pendingSubs.length;
  if (skippedCount > 0) {
    console.log(
      'ข้าม ' + skippedCount + ' ใบเพราะปิดงานแล้ว (อ้างอิงจากชีท Tickets) — เหลือต้อง fetch ' +
      pendingSubs.length + ' ใบ จากทั้งหมด ' + subIds.length + ' ใบ'
    );
  }

  // ==========================================
  // 4. FETCH DETAIL + UPSERT
  // ==========================================

  const detailResults = await rocket.mapConcurrent(pendingSubs, SUB_CONCURRENCY, async function(subId) {
    const html = await rocket.getTicketDetailHtml(subId, auth);
    const ticket = rocket.parseTicketDetail(html, subId);
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

  const ctx = await sheetsLib.ensureSheetAndBuildIndex(sheets, spreadsheetId, TRICK2_SHEET_NAME, TRICK2_HEADERS, TRICK2_JOBNO_COL);
  await sheetsLib.batchUpsert(sheets, spreadsheetId, TRICK2_SHEET_NAME, TRICK2_HEADERS, ctx, rows);

  console.log('เขียนแล้ว ' + rows.length + '/' + pendingSubs.length);
  console.log('DONE');

}

main().catch(function(err) {
  console.error('Sync ล้มเหลว:', err);
  process.exit(1);
});
