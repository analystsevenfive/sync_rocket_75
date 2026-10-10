const test = require('node:test');
const assert = require('node:assert/strict');
const { memoRange, splitDetails, extractMemoRows } = require('../sync-memo');

test('Memo range begins on first day of previous Bangkok month', () => {
  assert.deepEqual(memoRange(new Date('2026-10-10T05:00:00Z')),
    { from: '2026-09-01', to: '2026-10-10' });
});

test('Memo detail yields province and inclusive count of scheduled dates', () => {
  assert.deepEqual(splitDetails('กำหนดการช่างเดินทางติดตั้ง จ.สงขลา วันที่ 12-14 ตุลาคม 2569'),
    { province: 'สงขลา', date: '12-14 ตุลาคม 2569', countDate: 3 });
  assert.deepEqual(splitDetails('กำหนดการช่างเดินทางติดตั้ง จ.เพชรบุรี วันที่ 8-9 ตุลาคม 2569'),
    { province: 'เพชรบุรี', date: '8-9 ตุลาคม 2569', countDate: 2 });
  assert.deepEqual(splitDetails('กำหนดการช่างเดินทางติดตั้ง งานซ่อม จ. เชียงใหม่-เชียงราย วันที่ 6-9 ตุลาคม 2569'),
    { province: 'เชียงใหม่-เชียงราย', date: '6-9 ตุลาคม 2569', countDate: 4 });
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
