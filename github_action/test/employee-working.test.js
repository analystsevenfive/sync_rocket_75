const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseEmployeeList, parseEmployeeDetail, parseDetailPhotoUrl, sharedPhotoUrls, verifyDetail,
  asText, photoFormula, thaiName, toRow, HEADERS, DETAIL_FIELDS
} = require('../../HR/sync-employee-working');

// ข้อมูลสมมติ โครง HTML ตาม response จริงของ getTable.php
function row({ code = '0100001', userId = '0123456789', photo = '../images/0100001.png', phone = '', email = '' } = {}) {
  return `
    <tr id="tr_">
      <td><a href="${photo}" target="_blank"><img src="${photo}" width="100" height="100"></a></td>
      <td>${code}</td>
      <td>สมมติ  ทดสอบ</br></td>
      <td>
        เบอร์โทร : ${phone}</br>อีเมล : ${email}<br>
        วันที่เริ่มงาน : 17/04/2002<br>
        24 ปี 6 เดือน 21 วัน                </td>
      <td>
        BK020201 - เจ้าหน้าที่ขาย - อาวุโส <br>
        แผนก : การเงิน<br>
        บริษัท : บริษัทตัวอย่าง<br>
        ( Lv.7 )                 </td>
      <td>
        <span class='badge badge-light-success'>ใช้งาน</span> <!-- <span class="badge badge-success">ทำงาน</span><br>
        -->
      </td>
      <!--  -->
      <td class="text-center">
        <a href="employee_view.php?user_id=${userId}"><btn></btn></a>
        <!-- <button onclick="Modal_CheckDoc('9999999999')"></button> -->
      </td>
    </tr>`;
}

const table = rows => `<table><thead><tr role="row"><th></th><th>รหัสพนักงาน</th></tr></thead>${rows}</table>`;

test('employee row yields every list field', () => {
  assert.deepEqual(parseEmployeeList(table(row({ phone: '0812345678', email: 'a@example.com' }))), [{
    userId: '0123456789', employeeId: '0100001',
    photoUrl: 'https://rocket75.com/images/0100001.png',
    fullName: 'สมมติ ทดสอบ', phone: '0812345678', email: 'a@example.com',
    startDate: '17/04/2002', tenure: '24 ปี 6 เดือน 21 วัน',
    positionCode: 'BK020201', position: 'เจ้าหน้าที่ขาย - อาวุโส',
    department: 'การเงิน', company: 'บริษัทตัวอย่าง', level: '7', status: 'ใช้งาน', documents: {}
  }]);
});

test('blank phone does not absorb the email line', () => {
  const [employee] = parseEmployeeList(table(row({ email: 'a@example.com' })));
  assert.equal(employee.phone, '');
  assert.equal(employee.email, 'a@example.com');
});

test('all rows are read and the header row is skipped', () => {
  const ids = parseEmployeeList(table(row() + row({ code: '0100002', userId: '1111111111' })));
  assert.deepEqual(ids.map(e => e.employeeId), ['0100001', '0100002']);
});

test('employee without photo gets no image formula', () => {
  const html = table(row()).replace(/<td><a href[\s\S]*?<\/a><\/td>/, '<td></td>');
  assert.equal(parseEmployeeList(html)[0].photoUrl, '');
  assert.equal(photoFormula(''), '');
});

test('login page or empty response yields no rows', () => {
  assert.deepEqual(parseEmployeeList('<form><input type="password"></form>'), []);
});

test('sheet values keep leading zeros and cannot become formulas', () => {
  assert.equal(asText('0100001'), "'0100001");
  assert.equal(asText('=HYPERLINK("x")'), `'=HYPERLINK("x")`);
  assert.equal(asText(''), '');
});

// ข้อมูลสมมติ โครง HTML ตาม response จริงของ Get_Position.php
function detailHtml(overrides = {}) {
  const values = Object.assign(Object.fromEntries(DETAIL_FIELDS.map(label => [label, ''])),
    { 'ชื่อ (ไทย)': 'สมมติ', 'สกุล (ไทย)': 'ทดสอบ' }, overrides);
  return Object.entries(values).map(([label, value]) => `
    <div class="col-md-4">
      <div class="profile-label">${label}</div>
      <div class="profile-value">
        ${value}        </div>
    </div>`).join('');
}

test('detail fields are read by label, including blank values', () => {
  const detail = parseEmployeeDetail(detailHtml({ 'เลขบัตรประชาชน': '1000000000000' }));
  assert.equal(detail['เลขบัตรประชาชน'], '1000000000000');
  assert.equal(detail['ชื่อเล่น'], '');
  assert.deepEqual(Object.keys(detail).sort(), [...DETAIL_FIELDS].sort());
});

test('fields outside the approved list are not written to the row', () => {
  const html = detailHtml() + '<div class="profile-label">โรคประจำตัว</div><div class="profile-value">x</div>';
  const [employee] = parseEmployeeList(table(row()));
  const values = toRow(employee, parseEmployeeDetail(html), 'now');
  assert.equal(values.length, HEADERS.length);
  assert.ok(!values.includes("'x"));
});

test('detail for a different person stops the sync', () => {
  const [employee] = parseEmployeeList(table(row()));
  assert.doesNotThrow(() => verifyDetail(employee, parseEmployeeDetail(detailHtml())));
  assert.throws(() => verifyDetail(employee, parseEmployeeDetail(detailHtml({ 'ชื่อ (ไทย)': 'คนอื่น' }))),
    /does not match/);
});

test('english name or unique photo confirms an employee whose Thai name differs', () => {
  const [employee] = parseEmployeeList(table(row()));
  const differs = parseEmployeeDetail(detailHtml({ 'ชื่อ (ไทย)': 'สะกดอีกแบบ' }));
  assert.doesNotThrow(() => verifyDetail(employee, differs, true));
  const english = Object.assign({}, employee, { fullName: 'Sample Person' });
  assert.doesNotThrow(() => verifyDetail(english,
    parseEmployeeDetail(detailHtml({ 'ชื่อ (ไทย)': 'สมมติ', 'ชื่อ (อังกฤษ)': 'SAMPLE' }))));
});

test('conflicting name error reports only states, never profile values', () => {
  const [employee] = parseEmployeeList(table(row()));
  const secret = '1000000000000';
  const detail = parseEmployeeDetail(detailHtml({ 'ชื่อ (ไทย)': 'คนอื่น', 'เลขบัตรประชาชน': secret }));
  assert.throws(() => verifyDetail(employee, detail), error => {
    assert.match(error.message, /thai=different, english=blank, photo=different/);
    assert.ok(!error.message.includes(secret) && !error.message.includes('คนอื่น'));
    return true;
  });
});

test('nameless profile is unverified and writes list data only', () => {
  const [employee] = parseEmployeeList(table(row({ phone: '0812345678' })));
  const detail = parseEmployeeDetail(detailHtml({ 'ชื่อ (ไทย)': '', 'เลขบัตรประชาชน': '1000000000000' }));
  assert.equal(verifyDetail(employee, detail), false);
  const values = toRow(employee, {}, 'now');
  assert.equal(values.length, HEADERS.length);
  assert.equal(values[HEADERS.indexOf('เลขบัตรประชาชน')], '');
  assert.equal(values[HEADERS.indexOf('ชื่อ-สกุล')], "'สมมติ ทดสอบ");
  assert.equal(values[HEADERS.indexOf('โทรศัพท์มือถือ')], "'0812345678");
});

test('photo in the detail page resolves to the same url as the list', () => {
  const [employee] = parseEmployeeList(table(row()));
  assert.equal(parseDetailPhotoUrl('<a href="../images/0100001.png"><img src="../images/0100001.png"></a>'), employee.photoUrl);
  assert.equal(parseDetailPhotoUrl('<div></div>'), '');
});

test('photo used by several employees is not identity evidence', () => {
  const shared = sharedPhotoUrls([{ photoUrl: 'a' }, { photoUrl: 'b' }, { photoUrl: 'a' }]);
  assert.deepEqual([...shared], ['a']);
});

test('detail page with a missing field stops the sync', () => {
  const [employee] = parseEmployeeList(table(row()));
  assert.throws(() => verifyDetail(employee, parseEmployeeDetail('<form></form>')), /missing fields/);
});

test('mobile and email fall back to the list when detail is blank', () => {
  const [employee] = parseEmployeeList(table(row({ phone: '0812345678', email: 'a@example.com' })));
  const values = toRow(employee, parseEmployeeDetail(detailHtml()), 'now');
  assert.equal(values[HEADERS.indexOf('โทรศัพท์มือถือ')], "'0812345678");
  assert.equal(values[HEADERS.indexOf('อีเมล')], "'a@example.com");
});

test('row matches headers and only the photo is a formula', () => {
  const [employee] = parseEmployeeList(table(row()));
  const values = toRow(employee, parseEmployeeDetail(detailHtml()), '07/11/2026 12:00:00');
  assert.equal(values.length, HEADERS.length);
  assert.equal(values[0], '=IMAGE("https://rocket75.com/images/0100001.png")');
  assert.ok(values.slice(1).every(v => !String(v).startsWith('=')));
});

test('photo link column holds the plain url so Sheets makes it clickable', () => {
  const [employee] = parseEmployeeList(table(row()));
  const values = toRow(employee, {}, 'now');
  assert.equal(HEADERS.indexOf('ลิงก์รูป'), 1);
  assert.equal(values[1], 'https://rocket75.com/images/0100001.png');
  assert.equal(values[2], "'0100001");
  assert.equal(toRow({ ...employee, photoUrl: '' }, {}, 'now')[1], '');
});

test('name column keeps only the Thai name', () => {
  assert.equal(thaiName('อัญชสา บัวลอย Ms ANCHASA BUALOI'), 'อัญชสา บัวลอย');
  assert.equal(thaiName('ณัฐชัย สุดธารักษ์ Ḿr Natthachai Suttharak'), 'ณัฐชัย สุดธารักษ์');
  assert.equal(thaiName('สมมติ ทดสอบ'), 'สมมติ ทดสอบ');
  assert.equal(thaiName('John Smith'), 'John Smith');
  const [employee] = parseEmployeeList(table(row()));
  const values = toRow({ ...employee, fullName: 'สมมติ ทดสอบ Mr Sample Test' }, {}, 'now');
  assert.equal(values[HEADERS.indexOf('ชื่อ-สกุล')], "'สมมติ ทดสอบ");
});
