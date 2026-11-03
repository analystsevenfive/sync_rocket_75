const test = require('node:test');
const assert = require('node:assert/strict');
const { dateYear, shouldIncludeDashboardRow } = require('../sync-dashbaod');

function row(status, checkOut) {
  // Columns follow DASHBOARD_HEADERS; status=8 and Check Out Date=12.
  const values = Array(13).fill('');
  values[8] = status;
  values[12] = checkOut;
  return values;
}

test('dateYear supports Gregorian and Buddhist years', () => {
  assert.equal(dateYear('31/12/2026 17:00'), 2026);
  assert.equal(dateYear('31/12/2569'), 2026);
  assert.equal(dateYear(''), null);
});

test('includes unfinished work and only completed work checked out in 2026', () => {
  assert.equal(shouldIncludeDashboardRow(row('กำลังดำเนินการ', '')), true);
  assert.equal(shouldIncludeDashboardRow(row('จบงานแล้ว', '10/10/2026')), true);
  assert.equal(shouldIncludeDashboardRow(row('ซ่อมเสร็จแล้ว', '10/10/2025')), false);
  assert.equal(shouldIncludeDashboardRow(row('ปิดงานแล้ว', '')), false);
  assert.equal(shouldIncludeDashboardRow(row('', '10/10/2026')), true);
});
