const test = require('node:test');
const assert = require('node:assert/strict');
const { dateKey, isNewEmployee, toRow, HEADERS } = require('../../HR/sync-employee-new');
const working = require('../../HR/sync-employee-working');

const TODAY = '07/11/2026 14:07:08';
const startingOn = startDate => ({ startDate });

test('start date after today is a new employee', () => {
  assert.equal(isNewEmployee(startingOn('08/11/2026'), TODAY), true);
  assert.equal(isNewEmployee(startingOn('01/01/2027'), TODAY), true);
});

test('start date today or earlier is not a new employee', () => {
  assert.equal(isNewEmployee(startingOn('07/11/2026'), TODAY), false);
  assert.equal(isNewEmployee(startingOn('17/04/2002'), TODAY), false);
});

test('dates compare by year, month, then day rather than as text', () => {
  assert.equal(isNewEmployee(startingOn('31/10/2026'), TODAY), false);
  assert.equal(isNewEmployee(startingOn('01/12/2026'), TODAY), true);
});

test('blank or unreadable start date is never treated as new', () => {
  assert.equal(dateKey(''), null);
  assert.equal(isNewEmployee(startingOn(''), TODAY), false);
  assert.equal(isNewEmployee(startingOn('-'), TODAY), false);
});

// ข้อมูลสมมติ โครงเมนู "ไฟล์เอกสาร" ตาม response จริงของ getTable.php
function listHtml(menu) {
  return `<table><tr>
    <td><img src="../images/0100001.png"></td><td>0100001</td><td>สมมติ ทดสอบ</td>
    <td>วันที่เริ่มงาน : 08/11/2026</td><td>BK020201 - เจ้าหน้าที่ขาย<br>แผนก : ขาย</td>
    <td><span>ใช้งาน</span></td>
    <td><a href="employee_view.php?user_id=0123456789"></a>
      <div class="dropdown"><button>ไฟล์เอกสาร</button><ul class="dropdown-menu">${menu}</ul></div></td>
  </tr></table>`;
}
const MENU = `
  <li><a class="dropdown-item"
      href="../print/print_announce_new_employee.php?user_id=0123456789"
      target="_blank"><label>ประกาศพนักงานเริ่มงานใหม่</label></a></li>
  <li><a class="dropdown-item"
      href="../print/print_75Cover sheet.php?user_id=0123456789"
      target="_blank"><label>ใบปะหน้าแฟ้มประวัติ</label></a></li>
  <li><a class="dropdown-item"
      href="../print/print_checklist_orientation.php?id=0123456789"
      target="_blank"><label>Checklist ปฐมนิเทศ</label></a></li>`;

test('document menu links are read with absolute, encoded urls', () => {
  const [employee] = working.parseEmployeeList(listHtml(MENU));
  assert.deepEqual(employee.documents, {
    'ประกาศพนักงานเริ่มงานใหม่': 'https://rocket75.com/print/print_announce_new_employee.php?user_id=0123456789',
    'ใบปะหน้าแฟ้มประวัติ': 'https://rocket75.com/print/print_75Cover%20sheet.php?user_id=0123456789',
    'Checklist ปฐมนิเทศ': 'https://rocket75.com/print/print_checklist_orientation.php?id=0123456789'
  });
});

test('document columns follow the photo link and hold plain urls', () => {
  const [employee] = working.parseEmployeeList(listHtml(MENU));
  const values = toRow(employee, {}, 'now');
  assert.equal(values.length, HEADERS.length);
  assert.deepEqual(HEADERS.slice(0, 6),
    ['รูป', 'ลิงก์รูป', 'ประกาศพนักงานเริ่มงานใหม่', 'ใบปะหน้าแฟ้มประวัติ', 'Checklist ปฐมนิเทศ', 'รหัสพนักงาน']);
  assert.equal(values[2], employee.documents['ประกาศพนักงานเริ่มงานใหม่']);
  assert.equal(values[3], employee.documents['ใบปะหน้าแฟ้มประวัติ']);
  assert.equal(values[4], employee.documents['Checklist ปฐมนิเทศ']);
  assert.equal(values[5], "'0100001");
  assert.equal(values[HEADERS.indexOf('Last Sync')], "'now");
});

test('employee without the document menu gets blank document cells', () => {
  const [employee] = working.parseEmployeeList(listHtml(''));
  const values = toRow(employee, {}, 'now');
  assert.deepEqual(values.slice(2, 5), ['', '', '']);
});

test('Employee Working keeps its columns without document links', () => {
  assert.ok(!working.HEADERS.includes('ใบปะหน้าแฟ้มประวัติ'));
  const [employee] = working.parseEmployeeList(listHtml(MENU));
  assert.equal(working.toRow(employee, {}, 'now').length, working.HEADERS.length);
});
