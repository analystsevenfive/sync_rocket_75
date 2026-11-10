const test = require('node:test');
const assert = require('node:assert/strict');
const { toRow, HEADERS } = require('../../HR/sync-employee-it');

test('Employee for IT has only the requested columns, in order', () => {
  assert.deepEqual(HEADERS, ['ชื่อ-นามสกุล', 'ชื่อเล่น', 'รหัสพนักงาน', 'ตำแหน่ง', 'แผนก', 'บริษัท / สาขา', 'LV']);
});

test('row maps org chart fields and keeps the leading zero of the employee id', () => {
  const row = toRow({
    company: 'BK - สมมติ', department: 'ขาย', team: 'ไม่ใช้', position: 'เจ้าหน้าที่ขาย',
    level: 'L.3', employeeId: '0100001', fullName: 'สมมติ ทดสอบ', nickname: 'เอ', desk: '205'
  });
  assert.deepEqual(row, ['สมมติ ทดสอบ', 'เอ', "'0100001", 'เจ้าหน้าที่ขาย', 'ขาย', 'BK - สมมติ', 'L.3']);
});

test('missing fields become blank cells', () => {
  assert.deepEqual(toRow({ employeeId: '0100002' }), ['', '', "'0100002", '', '', '', '']);
});
