/*************************************************
 * SYNC EMPLOYEE FOR IT
 *
 * รายชื่อพนักงานชุดเดียวกับชีท Employee (ผังองค์กร /hr/organization_chart.php
 * ทุกบริษัทในตัวเลือก) แต่เขียนเฉพาะคอลัมน์ที่ IT ใช้ ลงชีท Employee for IT
 *************************************************/

const rocket = require('../github_action/lib/rocket-client');
const sheetsLib = require('../github_action/lib/sheets-client');
const employee = require('./sync-employee');

const SHEET_NAME = 'Employee for IT';
const HEADERS = ['ชื่อ-นามสกุล', 'ชื่อเล่น', 'รหัสพนักงาน', 'ตำแหน่ง', 'แผนก', 'บริษัท / สาขา', 'LV'];

function toRow(emp) {
  return [
    emp.fullName || '',
    emp.nickname || '',
    employee.forceTextIfNumeric(emp.employeeId),
    emp.position || '',
    emp.department || '',
    emp.company || '',
    emp.level || ''
  ];
}

async function main() {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('SPREADSHEET_ID is required');

  const auth = await rocket.rocketLogin();
  const rows = (await employee.collectEmployees(auth)).map(toRow);

  const sheets = await sheetsLib.getSheetsClient();
  const sheetId = await sheetsLib.ensureSheetExists(sheets, spreadsheetId, SHEET_NAME);
  await sheetsLib.replaceSheetData(sheets, spreadsheetId, sheetId, SHEET_NAME, HEADERS, rows);
  console.log(`Updated ${SHEET_NAME}: ${rows.length} rows`);
}

if (require.main === module) main().catch(error => {
  console.error('Employee for IT sync failed:', error.message);
  process.exit(1);
});

module.exports = { toRow, HEADERS };
