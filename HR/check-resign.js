/*************************************************
 * CHECK RESIGN
 *
 * อ่านแถว working status = Resign จากชีทพนักงานของ HR (SOURCE_SPREADSHEET_ID แท็บ gid=0)
 * แล้วเทียบกับรายชื่อพนักงานที่ยังทำงานใน Rocket (getTable.php ตัวเดียวกับ Employee Working)
 * คนที่ชีทบอก Resign แต่ Rocket ยังเป็นพนักงานที่ทำงานอยู่ = ยังไม่ได้บันทึกลาออก
 * เขียนรายชื่อลงแท็บ Resign Check ใน SPREADSHEET_ID
 *
 * อ่านอย่างเดียว: ไม่บันทึกหรือแก้ข้อมูลใดๆ ใน Rocket
 * ห้าม console.log ค่าของพนักงาน log เฉพาะจำนวนแถว
 *************************************************/

const rocket = require('../github_action/lib/rocket-client');
const sheetsLib = require('../github_action/lib/sheets-client');
const working = require('./sync-employee-working');

const SOURCE_SPREADSHEET_ID = '18Yg6R-T5PktbTfMJLYcXVpVZI4lKPJXYe6bk_PEIr7k';
const SOURCE_SHEET_GID = 0;
const SHEET_NAME = 'Resign Check';
const SOURCE_COLUMNS = {
  code: 'empcode', name: 'name', surname: 'surname', status: 'working status',
  startDate: 'วันที่เริ่มงาน', lastDay: 'วันทำงานท้าย', effectiveDate: 'วันที่พ้นสภาพ'
};
const HEADERS = [
  'รหัสพนักงาน', 'ชื่อ-สกุล (ชีท HR)', 'ชื่อ-สกุล (Rocket)', 'ชื่อตรงกัน',
  'วันที่เริ่มงาน (ชีท HR)', 'วันที่เริ่มงาน (Rocket)', 'วันทำงานวันสุดท้าย', 'วันที่มีผลลาออก',
  'ตำแหน่ง', 'แผนก', 'ต้องตรวจ', 'Last Sync'
];

const compact = value => String(value || '').replace(/\s+/g, '').toLowerCase();

// แปลงแถวของชีท HR เป็น object ตามชื่อ header ถ้าหา header ไม่เจอต้องหยุด ไม่ใช่อ่านผิดคอลัมน์
function parseSourceRows(values) {
  const [header = [], ...rows] = values || [];
  const names = header.map(h => String(h).trim().toLowerCase());
  const index = {};
  const missing = [];
  for (const [key, label] of Object.entries(SOURCE_COLUMNS)) {
    index[key] = names.indexOf(label.toLowerCase());
    if (index[key] < 0) missing.push(label);
  }
  if (missing.length) throw new Error(`HR sheet is missing columns: ${missing.join(', ')}`);
  return rows
    .map(row => Object.fromEntries(Object.keys(SOURCE_COLUMNS)
      .map(key => [key, String(row[index[key]] == null ? '' : row[index[key]]).trim()])))
    .filter(row => row.code);
}

function findUnrecordedResignations(sourceRows, employees) {
  const workingByCode = new Map(employees.map(e => [e.employeeId, e]));
  const workingInSheet = new Set(sourceRows
    .filter(row => compact(row.status) === 'working').map(row => row.code));
  return sourceRows
    .filter(row => compact(row.status) === 'resign' && workingByCode.has(row.code))
    .map(row => {
      const employee = workingByCode.get(row.code);
      const sheetName = `${row.name} ${row.surname}`.trim();
      const nameMatches = compact(sheetName) === compact(employee.fullName);
      const issues = [];
      if (!nameMatches) issues.push('ชื่อไม่ตรงกับ Rocket');
      if (row.startDate !== employee.startDate) issues.push('วันเริ่มงานไม่ตรงกับ Rocket');
      if (!row.effectiveDate) issues.push('ไม่มีวันที่พ้นสภาพ');
      if (!row.lastDay) issues.push('ไม่มีวันทำงานท้าย');
      if (workingInSheet.has(row.code)) issues.push('รหัสนี้มีแถว Working ในชีท HR ด้วย');
      return { row, employee, sheetName, nameMatches, issues };
    });
}

function toRow({ row, employee, sheetName, nameMatches, issues }, syncedAt) {
  return [
    row.code, sheetName, employee.fullName, nameMatches ? 'ตรง' : 'ไม่ตรง',
    row.startDate, employee.startDate, row.lastDay, row.effectiveDate,
    employee.position, employee.department, issues.join(', '), syncedAt
  ].map(working.asText);
}

async function readSourceSheet(sheets) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SOURCE_SPREADSHEET_ID, fields: 'sheets.properties(sheetId,title)'
  });
  const tab = meta.data.sheets.find(s => s.properties.sheetId === SOURCE_SHEET_GID);
  if (!tab) throw new Error(`HR sheet tab gid=${SOURCE_SHEET_GID} not found`);
  const title = tab.properties.title.replace(/'/g, "''");
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SOURCE_SPREADSHEET_ID, range: `'${title}'`
  });
  return res.data.values || [];
}

async function main() {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('SPREADSHEET_ID is required');

  const sheets = await sheetsLib.getSheetsClient();
  const sourceRows = parseSourceRows(await readSourceSheet(sheets));
  const resignCount = sourceRows.filter(row => compact(row.status) === 'resign').length;
  if (!resignCount) throw new Error('No Resign rows found in the HR sheet; keeping previous check');

  const auth = await rocket.rocketLogin();
  const employees = working.parseEmployeeList(await working.fetchEmployeeList(auth));
  if (!employees.length) throw new Error('No employee rows could be read from Rocket; keeping previous check');

  const pending = findUnrecordedResignations(sourceRows, employees);
  const now = rocket.formatDateTimeBangkok(new Date());
  const sheetId = await sheetsLib.ensureSheetExists(sheets, spreadsheetId, SHEET_NAME);
  const summaryText = `ข้อมูล ณ ${now} | ชีท HR มี Resign ${resignCount} คน | ` +
    `ยังเป็นพนักงานที่ทำงานอยู่ใน Rocket ${pending.length} คน`;
  await sheetsLib.replaceSheetDataWithSummary(sheets, spreadsheetId, sheetId, SHEET_NAME, summaryText,
    HEADERS, pending.map(item => toRow(item, now)));
  console.log(`HR sheet rows: ${sourceRows.length}, Resign: ${resignCount}, ` +
    `still working in Rocket: ${pending.length}, needs review: ${pending.filter(p => p.issues.length).length}`);
}

if (require.main === module) main().catch(error => {
  console.error('Resign check failed:', error.message);
  process.exit(1);
});

module.exports = { parseSourceRows, findUnrecordedResignations, toRow, HEADERS };
