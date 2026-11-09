/*************************************************
 * SYNC EMPLOYEE NEW
 *
 * พนักงานใหม่ = วันที่เริ่มงานอยู่หลังวันนี้ (เวลาไทย) วันเริ่มงานตรงกับวันนี้ไม่นับ
 * ใช้รายชื่อและรูปแบบแถวเดียวกับ Employee Working เขียนลงชีท Employee New แบบ snapshot
 * ไม่มีใครเข้าเงื่อนไขก็ต้องเขียนชีทว่าง เพื่อล้างคนที่เริ่มงานแล้วออก
 *
 * ชีทนี้มีข้อมูลส่วนบุคคล: ห้าม console.log ค่าของพนักงาน log เฉพาะจำนวนแถวและรหัสพนักงาน
 *************************************************/

const rocket = require('../github_action/lib/rocket-client');
const working = require('./sync-employee-working');

const SHEET_NAME = 'Employee New';
// ลิงก์จากเมนู "ไฟล์เอกสาร" ในหน้ารายชื่อ เปิดได้เฉพาะคนที่ login rocket75.com
const DOCUMENT_LABELS = ['ใบปะหน้าแฟ้มประวัติ', 'Checklist ปฐมนิเทศ'];
const PHOTO_COLUMNS = working.HEADERS.indexOf('ลิงก์รูป') + 1;
const HEADERS = [
  ...working.HEADERS.slice(0, PHOTO_COLUMNS), ...DOCUMENT_LABELS, ...working.HEADERS.slice(PHOTO_COLUMNS)
];

// ลิงก์เป็น URL ล้วน ไม่ผ่าน asText เพื่อให้ Sheets ทำเป็นลิงก์กดได้ เหมือนคอลัมน์ลิงก์รูป
function toRow(employee, detail, syncedAt) {
  const row = working.toRow(employee, detail, syncedAt);
  const documents = DOCUMENT_LABELS.map(label => (employee.documents || {})[label] || '');
  return [...row.slice(0, PHOTO_COLUMNS), ...documents, ...row.slice(PHOTO_COLUMNS)];
}

// dd/mm/yyyy -> เลข yyyymmdd เทียบมากน้อยได้ตรงๆ อ่านไม่ได้คืน null
function dateKey(text) {
  const match = String(text || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return match ? Number(match[3] + match[2] + match[1]) : null;
}

function isNewEmployee(employee, today) {
  const start = dateKey(employee.startDate);
  return start !== null && start > dateKey(today);
}

async function main() {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('SPREADSHEET_ID is required');

  const auth = await rocket.rocketLogin();
  const employees = working.parseEmployeeList(await working.fetchEmployeeList(auth));
  if (!employees.length) throw new Error('No employee rows could be read from Rocket; keeping previous sheet data');

  const unreadable = employees.filter(employee => dateKey(employee.startDate) === null);
  if (unreadable.length) {
    console.log(`Unreadable start date, skipped: ${unreadable.map(e => e.employeeId).join(', ')}`);
  }

  const today = rocket.formatDateTimeBangkok(new Date());
  const newEmployees = employees.filter(employee => isNewEmployee(employee, today));
  const details = await working.loadDetails(auth, newEmployees, working.sharedPhotoUrls(employees));
  await working.writeEmployeeSheet(spreadsheetId, SHEET_NAME, 'พนักงานใหม่', newEmployees, details,
    { headers: HEADERS, buildRow: toRow });
}

if (require.main === module) main().catch(error => {
  console.error('Employee New sync failed:', error.message);
  process.exit(1);
});

module.exports = { dateKey, isNewEmployee, toRow, HEADERS };
