const test = require('node:test');
const assert = require('node:assert/strict');
const { memoRange, splitDetails, splitTechniciansAndPlates, extractMemoRows,
  memoPdfCandidates, memoApprovalEvidenceCandidates } = require('../sync-memo');

test('vehicle registration is separated from technician names', () => {
  assert.deepEqual(splitTechniciansAndPlates('1.ช่างคนแรก\n2.ช่างคนที่สอง\n3ฅย75 - Isuzu 75 ช่าง'),
    { technicians: '1.ช่างคนแรก\n2.ช่างคนที่สอง', plates: 'ฅย75 - Isuzu 75' });
  assert.deepEqual(splitTechniciansAndPlates('1.ช่างคนแรก\n2ฒส75 - Isuzu 75 ช่าง'),
    { technicians: '1.ช่างคนแรก', plates: 'ฒส75 - Isuzu 75' });
  assert.deepEqual(splitTechniciansAndPlates('1.ช่างคนแรก\n2.ช่างคนที่สอง'),
    { technicians: '1.ช่างคนแรก\n2.ช่างคนที่สอง', plates: '' });
});

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
    <td>ช่างหนึ่ง<br>ช่างสอง</td><td>file.pdf</td><td>
      <a href="memo_edit.php?id=123">แก้ไข</a><a href="memo_print.php?id=123">พิมพ์</a></td>
  </tr></table>`;
  const rows = extractMemoRows(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject, 'งานติดตั้ง');
  assert.equal(rows[0].detail, 'จ.สงขลา วันที่ 12-14 ตุลาคม 2569');
  assert.equal(rows[0].createdAt, '10/10/2026 13:15');
  assert.match(rows[0].refs, /BKIN1026-000166/);
  assert.equal(rows[0].url, 'https://rocket75.com/print/75_memo.php?id=123');
  assert.equal(rows[0].editUrl, 'https://rocket75.com/main/memo_edit.php?id=123');
  assert.equal(rows[0].pdfUrl, 'https://rocket75.com/print/75_memo.php?id=123');
});

test('Memo edit link is converted to the public print link when the table has no PDF link', () => {
  const html = `<table><tr><td>งาน</td><td>รายละเอียด</td>
    <td>ผู้ทำรายการ<br>10/10/2026 13:15</td><td>JOB-1</td><td>ช่าง</td><td></td>
    <td><a href="memo_edit.php?id=9518152564">แก้ไข</a></td></tr></table>`;
  const [row] = extractMemoRows(html);
  assert.equal(row.url, 'https://rocket75.com/print/75_memo.php?id=9518152564');
  assert.equal(row.editUrl, 'https://rocket75.com/main/memo_edit.php?id=9518152564');
});

test('Memo PDF links are discovered from detail page attributes and JavaScript', () => {
  const html = `<iframe src="../print/memo.pdf?id=1"></iframe>
    <button onclick="window.open('memo_print.php?id=2')">print</button>`;
  assert.deepEqual(memoPdfCandidates(html, 'https://rocket75.com/main/memo_edit.php?id=2'), [
    'https://rocket75.com/print/memo.pdf?id=1',
    'https://rocket75.com/main/memo_print.php?id=2'
  ]);
});

test('Memo approval evidence images are read only from the existing evidence section', () => {
  const html = `<img src="upload/other.jpg">
    <h4>หลักฐานการอนุมัติที่มีอยู่</h4>
    <a href="upload/memo_img/one.jpg"><img src="upload/memo_img/two.png"></a>`;
  assert.deepEqual(memoApprovalEvidenceCandidates(html, 'https://rocket75.com/main/memo_edit.php?id=2'), [
    'https://rocket75.com/main/upload/memo_img/one.jpg',
    'https://rocket75.com/main/upload/memo_img/two.png'
  ]);
});
