/*************************************************
 * SYNC DASHBOARD — รายงาน > ภาพรวม (report_ticket.php)
 *
 * ยิง export ตัวเดียวกับปุ่ม "รายงาน" ของหน้านั้น
 * (ajax/report_ticket/overall/export_overall_new.php —
 * ยืนยันใน test/ticket_report.js แล้วว่าได้ xlsx ราย
 * ticket ครบ) กรองสาขา "กรุงเทพ" ตั้งแต่ 01/01/2025
 * ถึงวันนี้ แล้วเลือกเฉพาะคอลัมน์ตามตัวอย่างลงชีท
 *************************************************/

const XLSX = require('xlsx');
const rocket = require('./lib/rocket-client');
const sheetsLib = require('./lib/sheets-client');

const DASHBOARD_SHEET_NAME = 'Dashboard';
const START_DATE = '01/01/2025';
const BRANCH_NAME = 'กรุงเทพ';

// ชื่อคอลัมน์ตรงกับ header ใน xlsx ที่ export มา
const DASHBOARD_HEADERS = [
  'ประเภทงาน', 'วันที่แจ้งซ่อม', 'Ticket', 'ชื่อลูกค้า', 'สาขาลูกค้า',
  'ยี่ห้อสินค้า', 'รุ่นสินค้า', 'สถานะประกัน', 'สถานะงาน', 'เวลาทั้งหมด',
  'บันทึกประจำวัน'
];



function requestHeaders(auth) {
  const headers = {
    Origin: rocket.ROCKET_BASE,
    Referer: rocket.ROCKET_BASE + '/main/report_ticket.php',
    'X-Requested-With': 'XMLHttpRequest'
  };
  if (auth.cookie) {
    headers.Cookie = auth.cookie;
  }
  return headers;
}



// value ของ option "กรุงเทพ" ใน dropdown สาขา (area_select_main)
// อ่านจากหน้าจริงแทนการ hardcode เผื่อ id เปลี่ยน
async function resolveBranchValue(auth) {
  const res = await rocket.fetchWithTimeout(rocket.ROCKET_BASE + '/main/report_ticket.php', {
    method: 'GET',
    headers: requestHeaders(auth)
  });
  const html = await res.text();

  const select = html.match(/<select[^>]*(?:id|name)=["']area_select_main["'][\s\S]*?<\/select>/i);
  if (!select) {
    throw new Error('ไม่เจอ dropdown สาขา (area_select_main) ในหน้า report_ticket.php');
  }

  const optionRe = /<option[^>]*value=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi;
  let m;
  while ((m = optionRe.exec(select[0])) !== null) {
    if (rocket.cleanText(m[2]).includes(BRANCH_NAME)) {
      return m[1];
    }
  }
  throw new Error('ไม่เจอสาขา "' + BRANCH_NAME + '" ใน dropdown สาขา');
}



async function getOverallReport(auth, startDate, endDate, areaValue) {
  const body = new URLSearchParams({
    status: '', start_date: startDate, end_date: endDate,
    search_team: 'x', search_staff: 'x', area_select_main: areaValue,
    sub_status: 'undefined', brand_id: '', model_id: '',
    search_type: 'x', name_search: '',
    token: auth.token, key: auth.key
  });

  const res = await rocket.fetchWithTimeout(
    rocket.ROCKET_BASE + '/main/ajax/report_ticket/overall/export_overall_new.php',
    { method: 'POST', headers: requestHeaders(auth), body: body },
    300000
  );
  if (!res.ok) {
    throw new Error('Overall report HTTP ' + res.status);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.subarray(0, 2).toString() !== 'PK') {
    throw new Error('Overall report ไม่ได้คืนไฟล์ Excel: ' + buffer.toString('utf8', 0, 300));
  }
  return buffer;
}



function extractDashboardRows(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error('Overall report ไม่มี worksheet');

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  const headerIndex = rows.findIndex(row => row.some(cell => String(cell).trim() === 'Ticket'));
  if (headerIndex < 0) throw new Error('Overall report ไม่มี header "Ticket"');

  const header = rows[headerIndex].map(cell => String(cell).trim());
  const columns = DASHBOARD_HEADERS.map(function(name) {
    const i = header.indexOf(name);
    if (i < 0) throw new Error('Overall report ไม่มีคอลัมน์ "' + name + '"');
    return i;
  });
  const ticketCol = header.indexOf('Ticket');

  return rows.slice(headerIndex + 1)
    .filter(row => String(row[ticketCol] || '').trim())
    .map(row => columns.map(i => String(row[i] == null ? '' : row[i]).trim()));
}



async function main() {

  console.log('========== DASHBOARD SYNC (รายงานภาพรวม) ==========');

  const auth = await rocket.rocketLogin();
  console.log('LOGIN OK');

  const endDate = rocket.computeTodayRangeBangkok().end;
  console.log('ช่วงวันที่: ' + START_DATE + ' - ' + endDate);

  const areaValue = await resolveBranchValue(auth);
  console.log('สาขา ' + BRANCH_NAME + ' = ' + areaValue);

  const buffer = await getOverallReport(auth, START_DATE, endDate, areaValue);
  const rows = extractDashboardRows(buffer);
  console.log('ROWS: ' + rows.length);

  if (rows.length === 0) {
    throw new Error('ได้ 0 แถว — น่าจะเป็น fetch/parse ผิดพลาด ไม่เขียนทับชีท');
  }

  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new Error('ไม่พบ SPREADSHEET_ID ใน environment variables');
  }
  const sheets = await sheetsLib.getSheetsClient();
  const sheetId = await sheetsLib.ensureSheetExists(sheets, spreadsheetId, DASHBOARD_SHEET_NAME);

  const lastSync = rocket.formatDateTimeBangkok(new Date());
  const summaryText = 'สาขา ' + BRANCH_NAME + ' | ช่วงข้อมูล ' + START_DATE + ' - ' + endDate +
    ' | จำนวน ' + rows.length.toLocaleString('en-US') + ' รายการ | Last Sync ' + lastSync;
  await sheetsLib.replaceSheetDataWithSummary(sheets, spreadsheetId, sheetId, DASHBOARD_SHEET_NAME, summaryText, DASHBOARD_HEADERS, rows);

  console.log('เขียนลงชีท \'' + DASHBOARD_SHEET_NAME + '\' สำเร็จ: ' + rows.length + ' แถว');
  console.log('DONE');

}

main().catch(function(err) {
  console.error('Sync ล้มเหลว:', err);
  process.exit(1);
});
