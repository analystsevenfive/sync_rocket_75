const test = require('node:test');
const assert = require('node:assert/strict');
const { memoRange, splitDetails, splitTechniciansAndPlates, extractMemoRows } = require('../sync-memo');

test('vehicle registration is separated from technician names', () => {
  assert.deepEqual(splitTechniciansAndPlates('1.ช่างคนแรก\n2.ช่างคนที่สอง\n3ฅย75 - Isuzu 75 ช่าง'),
    { technicians: '1.ช่างคนแรก\n2.ช่างคนที่สอง', plates: 'ฅย75 - Isuzu 75' });
  assert.deepEqual(splitTechniciansAndPlates('1.ช่างคนแรก\n2ฒส75 - Isuzu 75 ช่าง'),
    { technicians: '1.ช่างคนแรก', plates: 'ฒส75 - Isuzu 75' });
  assert.deepEqual(splitTechniciansAndPlates('1.ช่างคนแรก\n2.ช่างคนที่สอง'),
    { technicians: '1.ช่างคนแรก\n2.ช่างคนที่สอง', plates: '' });
});

test('Memo range covers the last 7 days in Bangkok time', () => {
  assert.deepEqual(memoRange(new Date('2026-11-06T05:00:00Z')),
    { from: '2026-10-30', to: '2026-11-06' });
  assert.deepEqual(memoRange(new Date('2026-01-02T18:00:00Z')),
    { from: '2025-12-27', to: '2026-01-03' });
});

test('Memo detail yields province and inclusive count of scheduled dates', () => {
  assert.deepEqual(splitDetails('กำหนดการช่างเดินทางติดตั้ง จ.สงขลา วันที่ 12-14 ตุลาคม 2569'),
    { province: 'สงขลา', date: '12-14 ตุลาคม 2569', countDate: 3 });
  assert.deepEqual(splitDetails('กำหนดการช่างเดินทางติดตั้ง จ.เพชรบุรี วันที่ 8-9 ตุลาคม 2569'),
    { province: 'เพชรบุรี', date: '8-9 ตุลาคม 2569', countDate: 2 });
  assert.deepEqual(splitDetails('กำหนดการช่างเดินทางติดตั้ง งานซ่อม จ. เชียงใหม่-เชียงราย วันที่ 6-9 ตุลาคม 2569'),
    { province: 'เชียงใหม่-เชียงราย', date: '6-9 ตุลาคม 2569', countDate: 4 });
});

test('Memo detail handles dates written across months or without วันที่', () => {
  assert.deepEqual(splitDetails('กำหนดการเดินทางงาน ซ่อม จ. ระยอง วันที่ 29ตุลาคม-2พฤศจิกายน 2569'),
    { province: 'ระยอง', date: '29 ตุลาคม - 2 พฤศจิกายน 2569', countDate: 5 });
  assert.deepEqual(splitDetails('กำหนดการช่างและจัดส่ง เดินทางไป-กลับ งานติดตั้ง จ.นครราชสีมา 4 พฤศจิกายน 2569'),
    { province: 'นครราชสีมา', date: '4 พฤศจิกายน 2569', countDate: 1 });
  assert.equal(splitDetails('งานซ่อม จ.ภูเก็ต วันที่ 30 ธันวาคม - 2 มกราคม 2570').countDate, 4);
  assert.equal(splitDetails('งานซ่อม จ.ภูเก็ต วันที่ 30 ธันวาคม 2569 ถึง 2 มกราคม 2570').countDate, 4);
});

test('Memo detail keeps a day count when the day does not exist in that month', () => {
  assert.deepEqual(splitDetails('กำหนดการช่างเดินทางติดตั้ง จ.เชียงใหม่ วันที่ 30-31 พฤศจิกายน 2569'),
    { province: 'เชียงใหม่', date: '30-31 พฤศจิกายน 2569', countDate: 2 });
  assert.equal(splitDetails('จ.เชียงใหม่ วันที่ 14-12 ตุลาคม 2569').countDate, '');
});

test('Memo detail reads branch names and does not swallow วันที่ into the province', () => {
  assert.equal(splitDetails('กำหนดการช่างเดินทาง ปฏิบัติงาน สาขาสมุย วันที่ 1-15 พฤศจิกายน 2569').province, 'สาขาสมุย');
  assert.equal(splitDetails('จ.ระยองวันที่ 2 พฤศจิกายน 2569').province, 'ระยอง');
  assert.equal(splitDetails('จ.ชลบุรี จ.ระยอง วันที่ 2 พฤศจิกายน 2569').province, 'ชลบุรี-ระยอง');
  assert.equal(splitDetails('เพื่อเข้าปฏิบัติงานสาขา วันที่ 29 ตุลาคม -12 พฤศจิกายน 2569').province, '');
  assert.equal(splitDetails('เพื่อเข้าปฏิบัติงานสาขา วันที่ 29 ตุลาคม -12 พฤศจิกายน 2569').countDate, 15);
});

test('Memo table keeps content and detail in separate columns', () => {
  const html = `<table><tr>
    <td>งานติดตั้ง</td><td>จ.สงขลา วันที่ 12-14 ตุลาคม 2569</td>
    <td>ผู้ทำรายการ<br>10/10/2026 13:15</td><td>BKIN1026-000165<br>BKIN1026-000166</td>
    <td>ช่างหนึ่ง<br>ช่างสอง</td><td>file.pdf</td><td><a href="memo_print.php?id=123">พิมพ์</a></td>
  </tr></table>`;
  const rows = extractMemoRows(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject, 'งานติดตั้ง');
  assert.equal(rows[0].detail, 'จ.สงขลา วันที่ 12-14 ตุลาคม 2569');
  assert.equal(rows[0].createdAt, '10/10/2026 13:15');
  assert.match(rows[0].refs, /BKIN1026-000166/);
});
