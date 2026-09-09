// Repair only missing Ticket No cells; support both historical and current layouts.
const rocket = require('./lib/rocket-client');
const sheetsLib = require('./lib/sheets-client');
const SHEET = "'Tickets'";

async function main() {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('Missing SPREADSHEET_ID');
  const sheets = await sheetsLib.getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId, range: SHEET + '!A1:AZ'
  });
  const values = res.data.values || [];
  const headerIndex = values.slice(0, 2).findIndex(row =>
    row.includes('Ticket ID') && row.includes('Ticket No'));
  if (headerIndex < 0) throw new Error('Tickets header not recognized; no data changed');
  const headers = values[headerIndex];
  const idCol = headers.indexOf('Ticket ID');
  const noCol = headers.indexOf('Ticket No');
  const targets = [];
  values.slice(headerIndex + 1).forEach((row, i) => {
    const id = String(row[idCol] || '').trim();
    if (/^\d+$/.test(id) && !String(row[noCol] || '').trim()) {
      targets.push({ id, row: headerIndex + 2 + i });
    }
  });
  if (!targets.length) {
    console.log('No missing Ticket No cells; DONE');
    return;
  }
  const auth = await rocket.rocketLogin();
  const results = await rocket.mapConcurrentStrict(targets, 20, async target => {
    const html = await rocket.getTicketDetailHtml(target.id, auth);
    const ticket = rocket.parseTicketDetail(html, target.id);
    if (!ticket.ticketNo) throw new Error('Missing Ticket No for ' + target.id);
    return {
      range: SHEET + '!' + sheetsLib.columnLetter(noCol + 1) + target.row,
      values: [[ticket.ticketNo]]
    };
  });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId, requestBody: { valueInputOption: 'RAW', data: results }
  });
  console.log('Repaired ' + results.length + ' Ticket No cells; DONE');
}

main().catch(function(err) {
  console.error('Backfill failed:', err);
  process.exit(1);
});
