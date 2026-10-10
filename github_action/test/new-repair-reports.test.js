const test = require('node:test');
const assert = require('node:assert/strict');
const { dateKey, extractParentRows } = require('../sync-new-repair-reports');

test('new repair reports reads newly created parent tickets from Rocket list', () => {
  const html = `<table><tr>
    <td><a href="ticket_view.php?id=123">BKRM1026-000189</a></td>
    <td>Creator<br>10/10/2026 13:15</td>
    <td><label><i class="fa-user"></i>: Customer</label><label><i class="fa-home"></i>: Branch</label></td>
    <td></td><td><span class="badge">Waiting</span></td>
  </tr></table>`;
  const rows = extractParentRows(html);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: '123', ticketNo: 'BKRM1026-000189', reportDate: '10/10/2026 13:15',
    customer: 'Customer', branch: 'Branch', statuses: ['Waiting']
  });
  assert.equal(dateKey(rows[0].reportDate), '2026-10-10');
});
