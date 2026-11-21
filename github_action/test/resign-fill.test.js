const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRows, selectEmployee } = require('../../HR/resign-fill');

const header = [
  'empcode', 'name', 'surname', 'orgcode', 'department', 'position', 'level',
  'work email', 'personal email', 'working age', 'working status', 'วันที่เริ่มงาน',
  'วันทำงานสุดท้าย', 'วันที่พ้นสภาพ', 'สาเหตุลาออก', 'update statatus rocket'
];
const employee = [
  '0426027', 'บดินทร์', 'อจละนันท์', 'BB', 'แผนกคลังสินค้า', 'ผู้จัดการแผนกคลังสินค้า',
  'L-07', '', '', '0 ปี 0 เดือน 6 วัน', 'Resign', '02/11/2026', '07/11/2026',
  '08/11/2026', 'ไม่ผ่านทดลองงาน', 'approve update rocket'
];

test('reads resignation row including reason', () => {
  const row = selectEmployee(parseRows([header, employee]), '0426027');
  assert.equal(row.lastDay, '07/11/2026');
  assert.equal(row.effectiveDate, '08/11/2026');
  assert.equal(row.reason, 'ไม่ผ่านทดลองงาน');
});
test('accepts an approved row whose web hr status is still Working', () => {
  const working = employee.slice();
  working[10] = 'Working';
  assert.equal(selectEmployee(parseRows([header, working]), '0426027').code, '0426027');
});
test('rejects a Resign row that is not approved for Rocket', () => {
  const pending = employee.slice();
  pending[15] = '';
  assert.throws(() => selectEmployee(parseRows([header, pending]), '0426027'), /ยังไม่อนุมัติ/);
});
test('rejects a sheet without the approval column', () => {
  assert.throws(() => parseRows([header.slice(0, 15), employee.slice(0, 15)]), /update statatus rocket/);
});
test('rejects duplicate employee codes', () => {
  assert.throws(() => selectEmployee(parseRows([header, employee, employee]), '0426027'), /ซ้ำ 2 แถว/);
});
test('reads the live sheet layout (working status web hr / สาเหตุ)', () => {
  const liveHeader = [
    'empcode', 'name', 'surname', 'วันที่เริ่มงาน', 'วันทำงานสุดท้าย', 'วันที่พ้นสภาพ', 'สาเหตุ',
    'หมายเหตุ', 'working status web hr', 'working status rocket', 'update statatus rocket',
    'update statatus rocket', 'empcode', 'working status rocket'
  ];
  const liveRow = [
    '0125028', 'พลกฤษณ์', 'สุขล้อม', '01/07/2025', '14/11/2026', '15/11/2026',
    'ออกผิดระเบียบ ไม่แจ้งก่อน 30 วัน', 'แจ้งลาออกไม่ถูกต้องตามระเบียบของบริษัท', 'Resign', '', 'approve update rocket'
  ];
  const row = selectEmployee(parseRows([liveHeader, liveRow]), '0125028');
  assert.equal(row.status, 'Resign');
  assert.equal(row.lastDay, '14/11/2026');
  assert.equal(row.effectiveDate, '15/11/2026');
  assert.equal(row.reason, 'ออกผิดระเบียบ ไม่แจ้งก่อน 30 วัน');
});
