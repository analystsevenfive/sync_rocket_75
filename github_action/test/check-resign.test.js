const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSourceRows, findUnrecordedResignations, toRow, HEADERS } = require('../../HR/check-resign');

// ข้อมูลสมมติ header ตามชีท HR จริง
const HEADER = ['empcode', 'name', 'surname', 'orgcode', 'department', 'position', 'level',
  'work email', 'personal email', 'working age', 'working status', 'วันที่เริ่มงาน', 'วันทำงานสุดท้าย', 'วันที่พ้นสภาพ'];
const sheetRow = (code, status, { name = 'สมมติ', surname = 'ทดสอบ', start = '01/01/2020', last = '30/10/2026', end = '31/10/2026' } = {}) =>
  [code, name, surname, 'BK', '', '', '', '', '', '', status, start, last, end];
const rocketEmployee = (employeeId, fullName = 'สมมติ ทดสอบ', startDate = '01/01/2020') =>
  ({ employeeId, fullName, startDate, position: 'ตำแหน่ง', department: 'แผนก' });

test('resigned in the HR sheet but still working in Rocket is reported', () => {
  const rows = parseSourceRows([HEADER, sheetRow('0100001', 'Resign'), sheetRow('0100002', 'Resign'), sheetRow('0100003', 'Working')]);
  const pending = findUnrecordedResignations(rows, [rocketEmployee('0100001'), rocketEmployee('0100003')]);
  assert.deepEqual(pending.map(p => p.row.code), ['0100001']);
  assert.deepEqual(pending[0].issues, []);
});

test('resignation already recorded in Rocket is not reported', () => {
  const rows = parseSourceRows([HEADER, sheetRow('0100002', 'Resign')]);
  assert.deepEqual(findUnrecordedResignations(rows, [rocketEmployee('0100001')]), []);
});

test('mismatched name, start date, missing dates and rehire are flagged for review', () => {
  const rows = parseSourceRows([HEADER,
    sheetRow('0100001', 'Resign', { name: 'คนอื่น', start: '02/02/2021', last: '', end: '' }),
    sheetRow('0100001', 'Working')]);
  const [item] = findUnrecordedResignations(rows, [rocketEmployee('0100001')]);
  assert.equal(item.nameMatches, false);
  assert.deepEqual(item.issues, ['ชื่อไม่ตรงกับ Rocket', 'วันเริ่มงานไม่ตรงกับ Rocket',
    'ไม่มีวันที่พ้นสภาพ', 'ไม่มีวันทำงานสุดท้าย', 'รหัสนี้มีแถว Working ในชีท HR ด้วย']);
});

test('status and header matching ignore case and spacing', () => {
  const header = HEADER.map(h => h === 'working status' ? ' Working Status ' : h);
  const rows = parseSourceRows([header, sheetRow('0100001', ' resign ')]);
  assert.equal(findUnrecordedResignations(rows, [rocketEmployee('0100001')]).length, 1);
});

test('missing source column stops the check instead of reading the wrong column', () => {
  assert.throws(() => parseSourceRows([HEADER.filter(h => h !== 'วันที่พ้นสภาพ')]), /missing columns: วันที่พ้นสภาพ/);
});

test('report row keeps leading zeros and dates as text', () => {
  const rows = parseSourceRows([HEADER, sheetRow('0100001', 'Resign')]);
  const [item] = findUnrecordedResignations(rows, [rocketEmployee('0100001')]);
  const values = toRow(item, 'now');
  assert.equal(values.length, HEADERS.length);
  assert.equal(values[0], "'0100001");
  assert.equal(values[HEADERS.indexOf('วันที่มีผลลาออก')], "'31/10/2026");
  assert.equal(values[HEADERS.indexOf('ชื่อตรงกัน')], "'ตรง");
});
