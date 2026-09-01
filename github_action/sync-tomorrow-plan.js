/*************************************************
 * SYNC TOMORROW TECHNICIAN PLAN
 *
 * รายงานตั๋วที่มี "วันที่นัดหมาย" (appointment) ตรงกับ
 * วันพรุ่งนี้เสมอ (ตามเวลากรุงเทพ) — ใช้ endpoint เดียวกับ
 * Tickets sync (getTable.php) แต่ส่ง date_type=2 แทน
 * date_type=1 (ยืนยันจริงจาก DevTools: dropdown "ค้นหาจาก
 * วัน" บนหน้า ticket_list.php เลือก "วันที่นัดหมาย" ตรงกับ
 * date_type=2 พอดี — คนละ field วันที่กับที่ Tickets/Trick2/
 * Ticket Stage ใช้อยู่ (date_type=1 น่าจะเป็นวันที่แจ้ง/
 * สร้างตั๋ว) เห็นชัดว่าเป็นสาเหตุที่ Tickets sync พลาดตั๋ว
 * เก่าที่ยังมีนัดหมายต่อเนื่อง (ดู BKRM0326-000649.R03 ที่
 * คุยกันไปก่อนหน้านี้)
 *
 * ไม่ต้องมี skip-if-closed (ลิสต์นี้เล็ก เปลี่ยนทุกวันอยู่
 * แล้ว ไม่คุ้มจะ optimize) แต่ยังคง prune ไว้ — ถ้าวันไหน
 * ไม่มีนัดหมายเลยจริงๆ ชีทควรว่างเปล่าตามจริง (ต่างจาก
 * Tickets ที่ 0 รายการถือว่าผิดปกติ เพราะลิสต์นี้เป็นแค่
 * snapshot ของพรุ่งนี้ ไม่ใช่ข้อมูลสะสม 3 เดือน)
 *************************************************/

const rocket = require('./lib/rocket-client');
const sheetsLib = require('./lib/sheets-client');

const PLAN_SHEET_NAME = 'Tomorrow Technician Plan';
const DATE_TYPE_APPOINTMENT = '2';

const PARENT_CONCURRENCY = 30;
const SUB_CONCURRENCY = 30;

const PLAN_HEADERS = [
  'Ticket No', 'Appointment', 'Customer', 'Branch', 'Contact', 'Phone',
  'Problem Reported', 'Product Name', 'Technician', 'URL', 'Last Sync'
];

const TICKET_ID_COL = PLAN_HEADERS.length + 1; // เก็บ Ticket ID ไว้คอลัมน์ท้ายสุด ใช้เป็น upsert key เท่านั้น ไม่โชว์ตรงๆ ให้ผู้ใช้



function planToRow(d, lastSync) {
  return [
    d.ticketNo, d.appointment, d.customer, d.branch, d.contact, d.phone,
    d.problem, d.productName, d.technician, d.url, lastSync,
    d.ticketId
  ];
}



async function main() {

  console.log('========== TOMORROW TECHNICIAN PLAN SYNC (Node.js / GitHub Actions) ==========');

  const auth = await rocket.rocketLogin();
  console.log('LOGIN OK');

  const range = rocket.computeTomorrowRangeBangkok();
  console.log('วันพรุ่งนี้ (นัดหมาย): ' + range.start);

  // ==========================================
  // 1. PARENT TICKETS ที่มีนัดหมายพรุ่งนี้ (date_type=2)
  // ==========================================

  const parentHtml = await rocket.getParentTicketHtml(auth, range.start, range.end, DATE_TYPE_APPOINTMENT);
  const parentIds = rocket.extractParentTicketIds(parentHtml);
  console.log('PARENT TICKETS ที่มีนัดหมายพรุ่งนี้: ' + parentIds.length);

  // ==========================================
  // 2. SUB TICKETS ต่อ parent
  // ==========================================

  let subIds = [];

  if (parentIds.length > 0) {
    const checkRepairResults = await rocket.mapConcurrent(parentIds, PARENT_CONCURRENCY, async function(parentId) {
      const html = await rocket.getCheckRepairHtml(parentId, auth);
      return rocket.extractCheckRepairIds(html);
    });

    checkRepairResults.forEach(function(r, i) {
      if (r && r.__error) {
        console.log('ERROR Parent ' + parentIds[i] + ': ' + r.__error);
      } else if (Array.isArray(r)) {
        subIds = subIds.concat(r);
      }
    });
    subIds = [...new Set(subIds)];
  }

  console.log('SUB TICKETS: ' + subIds.length);

  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new Error('ไม่พบ SPREADSHEET_ID ใน environment variables');
  }
  const sheets = await sheetsLib.getSheetsClient();

  // ต่างจาก SpreadsheetApp — Sheets API ไม่สร้างแท็บ
  // ใหม่ให้อัตโนมัติ ต้องเช็ค+สร้างเองก่อนเสมอ
  const sheetId = await sheetsLib.ensureSheetExists(sheets, spreadsheetId, PLAN_SHEET_NAME);
  await sheetsLib.ensureGridSize(sheets, spreadsheetId, sheetId, subIds.length + 200);

  // ==========================================
  // 3. PRUNE — ลิสต์นี้เป็น snapshot ของพรุ่งนี้เท่านั้น
  // ตั๋วที่นัดหมายเลื่อน/ยกเลิกไปแล้วต้องหายจากชีทเลย
  // (ต่างจาก Tickets ที่ 0 รายการถือว่าผิดปกติ — ที่นี่ 0
  // รายการคือ "พรุ่งนี้ไม่มีนัดหมาย" ซึ่งเป็นไปได้จริง)
  // ==========================================

  const prunedCount = await sheetsLib.pruneStaleRows(
    sheets, spreadsheetId, sheetId, PLAN_SHEET_NAME, TICKET_ID_COL, new Set(subIds)
  );
  if (prunedCount > 0) {
    console.log('ลบ ' + prunedCount + ' แถวที่ไม่มีนัดหมายพรุ่งนี้แล้ว');
  }

  // ==========================================
  // 4. FETCH DETAIL + UPSERT
  // ==========================================

  const detailResults = await rocket.mapConcurrent(subIds, SUB_CONCURRENCY, async function(subId) {
    const html = await rocket.getTicketDetailHtml(subId, auth);
    const ticket = rocket.parseTicketDetail(html, subId);
    if (!ticket.ticketNo && !ticket.status) {
      throw new Error('หน้าที่ได้ไม่ใช่ ticket detail จริง (parse ไม่สำเร็จ)');
    }
    return ticket;
  });

  const lastSync = rocket.formatDateTimeBangkok(new Date());

  const rows = [];
  detailResults.forEach(function(r, i) {
    if (r && r.__error) {
      console.log('ERROR SubTicket ' + subIds[i] + ': ' + r.__error);
    } else if (r) {
      rows.push({ key: String(r.ticketId), row: planToRow(r, lastSync) });
    }
  });

  const ctx = await sheetsLib.ensureSheetAndBuildIndex(sheets, spreadsheetId, PLAN_SHEET_NAME, PLAN_HEADERS.concat(['Ticket ID']), TICKET_ID_COL);
  await sheetsLib.batchUpsert(sheets, spreadsheetId, sheetId, PLAN_SHEET_NAME, PLAN_HEADERS.concat(['Ticket ID']), ctx, rows);

  console.log('เขียนแล้ว ' + rows.length + '/' + subIds.length);
  console.log('DONE');

}

main().catch(function(err) {
  console.error('Sync ล้มเหลว:', err);
  process.exit(1);
});
