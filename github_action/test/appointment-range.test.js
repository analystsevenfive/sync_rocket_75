const test = require('node:test');
const assert = require('node:assert/strict');
const rocket = require('../lib/rocket-client');

test('manual appointment range includes both endpoints and keeps the default day', () => {
  const defaultRange = rocket.computeTodayRangeBangkok(new Date('2026-10-14T02:00:00Z'));
  const fallback = rocket.resolveAppointmentRange(defaultRange, '', '');
  assert.equal(fallback.start, '14/10/2026');
  assert.equal(fallback.end, '14/10/2026');

  const range = rocket.resolveAppointmentRange(defaultRange, '2026-10-12', '2026-10-14');
  assert.equal(range.start, '12/10/2026');
  assert.equal(range.end, '14/10/2026');
  assert.equal(rocket.isDateInAppointmentRange('12 Oct 2026 08:00', range), true);
  assert.equal(rocket.isDateInAppointmentRange('14 Oct 2026 17:00', range), true);
  assert.equal(rocket.isDateInAppointmentRange('15 Oct 2026 08:00', range), false);
  const slashRange = rocket.resolveAppointmentRange(defaultRange, '2026/10/13', '2026/10/14');
  assert.equal(slashRange.start, '13/10/2026');
  assert.equal(slashRange.end, '14/10/2026');
  assert.equal(rocket.isDateInAppointmentRange('13 Oct 2026 08:00', slashRange), true);
});

test('manual appointment range rejects invalid or reversed dates', () => {
  const defaultRange = rocket.computeTodayRangeBangkok(new Date('2026-10-14T02:00:00Z'));
  assert.throws(() => rocket.resolveAppointmentRange(defaultRange, '2026-02-30', ''), /Invalid appointment date/);
  assert.throws(() => rocket.resolveAppointmentRange(defaultRange, '14/10/2026', ''), /YYYY-MM-DD/);
  assert.throws(() => rocket.resolveAppointmentRange(defaultRange, '2026-10-15', '2026-10-14'), /on or before/);
});
