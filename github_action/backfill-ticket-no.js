/*************************************************
 * BACKFILL (รันครั้งเดียว) — แก้แถวในชีท "Tickets" ที่
 * คอลัมน์ "Ticket No" ว่างเปล่า
 *
 * ที่มา: ticketNo เดิม parse จาก <h1> ด้วย regex ที่เดา
 * รูปแบบ suffix (".R<เลข>") ผิด ทำให้ตั๋วประเภทอื่น (เช่น
 * ".C<เลข>" ของงาน PM) ได้ Ticket No ว่าง แถวนั้นถูกเขียน
 * ไปแล้วตั้งแต่ก่อนแก้ regex (ดู commit 6de343f) — ถ้าตั๋ว
 * ปิดงานแล้ว (Repair Result = "ซ่อมเรียบร้อย") sync ปกติจะ
 * "skip-if-closed" ไม่ fetch ซ้ำอีกเลย ทำให้แถวเสียค้างอยู่
 * ถาวรแม้ regex จะแก้แล้วก็ตาม — สคริปต์นี้ไล่ fetch เฉพาะ
 * แถวที่ Ticket No ว่างเท่านั้น (ไม่แตะแถวอื่นที่ปกติดีอยู่)
 * แล้วเขียนทับด้วยข้อมูลที่ถูกต้อง
 *************************************************/

const rocket = require('./lib/rocket-client');
const sheetsLib = require('./lib/sheets-client');

const TICKETS_SHEET_NAME = 'Tickets';
const CONCURRENCY = 20;

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
const TICKET_NO_COL = TICKET_HEADERS.indexOf('Ticket No') + 1;



// เหมือน sync-tickets.js เป๊ะ — กันเบอร์โทรเลข 0 นำหน้าหาย
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



// อ่านคอลัมน์ Ticket ID + Ticket No คู่กัน คืน list ของ
// Ticket ID ที่มี id แต่ Ticket No ว่างเปล่า
async function findTicketIdsMissingTicketNo(sheets, spreadsheetId) {

  const idCol = sheetsLib.columnLetter(TICKET_ID_COL);
  const noCol = sheetsLib.columnLetter(TICKET_NO_COL);

  const idsRes = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId,
    range: "'" + TICKETS_SHEET_NAME + "'!" + idCol + '2:' + idCol
  });
  const noRes = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId,
    range: "'" + TICKETS_SHEET_NAME + "'!" + noCol + '2:' + noCol
  });

  const ids = idsRes.data.values || [];
  const nos = noRes.data.values || [];

  const result = [];
  ids.forEach(function(row, i) {
    const id = row[0];
    const no = nos[i] && nos[i][0];
    if (id && !no) {
      result.push(String(id));
    }
  });

  return result;

}



async function main() {

  console.log('========== BACKFILL: แก้ Ticket No ที่ว่างเปล่า ==========');

  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new Error('ไม่พบ SPREADSHEET_ID ใน environment variables');
  }
  const sheets = await sheetsLib.getSheetsClient();

  const idsToFix = await findTicketIdsMissingTicketNo(sheets, spreadsheetId);
  console.log('พบ ' + idsToFix.length + ' แถวที่ Ticket No ว่างเปล่า');

  if (idsToFix.length === 0) {
    console.log('ไม่มีอะไรต้องแก้ — DONE');
    return;
  }

  const auth = await rocket.rocketLogin();
  console.log('LOGIN OK');

  const detailResults = await rocket.mapConcurrent(idsToFix, CONCURRENCY, async function(ticketId) {
    const html = await rocket.getTicketDetailHtml(ticketId, auth);
    const ticket = rocket.parseTicketDetail(html, ticketId);
    if (!ticket.ticketNo && !ticket.status) {
      throw new Error('parse ไม่สำเร็จ (อาจเป็น ticket ที่ถูกลบ/ย้ายไปแล้ว)');
    }
    return ticket;
  });

  const lastSync = rocket.formatDateTimeBangkok(new Date());
  const rows = [];

  detailResults.forEach(function(r, i) {
    if (r && r.__error) {
      console.log('ข้าม ' + idsToFix[i] + ': ' + r.__error);
    } else if (r) {
      console.log('แก้ ' + idsToFix[i] + ' -> Ticket No = "' + r.ticketNo + '"');
      rows.push({ key: String(r.ticketId), row: ticketToRow(r, lastSync) });
    }
  });

  const sheetId = await sheetsLib.ensureSheetExists(sheets, spreadsheetId, TICKETS_SHEET_NAME);
  const ctx = await sheetsLib.ensureSheetAndBuildIndex(sheets, spreadsheetId, TICKETS_SHEET_NAME, TICKET_HEADERS, TICKET_ID_COL);
  await sheetsLib.batchUpsert(sheets, spreadsheetId, sheetId, TICKETS_SHEET_NAME, TICKET_HEADERS, ctx, rows);

  console.log('แก้แล้ว ' + rows.length + '/' + idsToFix.length);
  console.log('DONE');

}

main().catch(function(err) {
  console.error('Backfill ล้มเหลว:', err);
  process.exit(1);
});
