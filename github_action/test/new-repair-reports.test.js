const test = require('node:test');
const assert = require('node:assert/strict');
const { dateKey, inputDateKey, extractParentRows, reportRow } = require('../sync-new-repair-reports');

test('workflow dates accept blank, ISO, and Rocket display format', () => {
  assert.equal(inputDateKey('', '2026-10-10'), '2026-10-10');
  assert.equal(inputDateKey(' 2026-10-10 ', ''), '2026-10-10');
  assert.equal(inputDateKey('10/10/2026', ''), '2026-10-10');
  assert.throws(() => inputDateKey('31/02/2026', ''), /Invalid Report Date/);
});

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

test('report row combines parent, overview, and repair detail in header order', () => {
  const parent = { id: '123', ticketNo: 'BKRM1026-000189', reportDate: '10/10/2026 13:15',
    customer: 'List customer', branch: 'List branch', statuses: ['Waiting'] };
  const overview = { customer: 'Overview customer', branch: 'Overview branch', contact: 'Person',
    phone: '0123456789', problem: 'Broken', productCode: '456', productName: 'Machine', serial: '123456' };
  const detail = { ticketId: '321', ticketNo: 'BKRM1026-000189.R1', appointment: '11/10/2026',
    endTime: '12/10/2026', url: 'https://example.test/ticket' };
  const row = reportRow(parent, overview, detail, { technicians: 'Tech', team: 'Team' },
    { status: 'Passed' }, '0007', '0012', '10/10/2026 14:00');
  assert.equal(row.length, 25);
  assert.deepEqual(row.slice(0, 6), ['321', 'BKRM1026-000189.R1', '10/10/2026 13:15',
    '11/10/2026', '12/10/2026', 'Passed']);
  assert.equal(row[10], "'0012");
  assert.equal(row[11], 'Overview customer');
  assert.equal(row[13], "'0007");
  assert.equal(row[15], "'0123456789");
  assert.equal(row[19], 'Tech');
  assert.equal(row[24], 'On-site');
});
