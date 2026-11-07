const test = require('node:test');
const assert = require('node:assert/strict');
const { dateKey, isNewEmployee } = require('../../HR/sync-employee-new');

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
