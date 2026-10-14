const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { parseWorkOrderSentReport } = require('../lib/work-order-report');

test('reads sent flag by ticket number from Rocket check-ticket export', () => {
  const rows = [
    ['เลขที่ใบงาน', 'วันที่นัดหมาย', 'รหัสลูกค้า', 'ชื่อบริษัท', 'สาขา', 'โมเดล', 'Est Time', 'ผู้ปฎิบัติงาน', '', 'วันที่ส่งใบงาน', 'สถานะงาน'],
    ['', '', '', '', '', '', '', 'ชื่อช่าง', 'ลายเซ็น'],
    ['BKRM1026-000236.R01', '13/10/2026 10:00', '', '', '', '', '', '', '', 'YES', ''],
    ['BKRM1026-000187.R01', '13/10/2026 10:00', '', '', '', '', '', '', '', '', '']
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Worksheet');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const values = parseWorkOrderSentReport(buffer);
  assert.equal(values.get('BKRM1026-000236.R01'), 'YES');
  assert.equal(values.get('BKRM1026-000187.R01'), '');
  assert.equal(values.size, 2);
});
