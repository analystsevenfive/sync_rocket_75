const rocket = require('./lib/rocket-client');
const sheetsLib = require('./lib/sheets-client');

const SOURCE_SHEET = 'Daily Repair Update';
const TARGET_SHEET = 'On-site Appointments';
const WORK_TYPE_HEADER = 'Shop / On-site Work';

const SOURCE_HEADERS = [
  'Ticket ID', 'Ticket No', 'Report Date', 'Appointment', 'End Time',
  'Inspection Status', 'Active Stage', 'Status 1', 'Status 2', 'Status 3',
  'Sales Invoice No.', 'Customer', 'Branch', 'Customer Code', 'Contact',
  'Phone', 'Problem Reported', 'Product Code', 'Product Name', 'Technician',
  'Team', 'Serial', 'URL', 'Last Sync'
];

const TARGET_HEADERS = [...SOURCE_HEADERS, WORK_TYPE_HEADER];

function isShopWork(ticket) {
  const text = [ticket.branch, ticket.customer, ticket.workDescription,
    ticket.machineLocation, ticket.problem].join(' ').toLowerCase();
  return /คลังสินค้า|ตึก\s*75|test\s*kitchen|warehouse|workshop|ศูนย์บริการ/.test(text);
}

async function main() {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('SPREADSHEET_ID is required');

  const sheets = await sheetsLib.getSheetsClient();
  const range = rocket.computeTodayRangeBangkok();
  const todayKey = `${range.dateParts.year}-${String(range.dateParts.month).padStart(2, '0')}-${String(range.dateParts.day).padStart(2, '0')}`;

  const source = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SOURCE_SHEET}'!A1:X`,
    valueRenderOption: 'FORMATTED_VALUE'
  });
  const values = source.data.values || [];
  if (!values.length) throw new Error(`Source sheet ${SOURCE_SHEET} is empty`);

  const headerRowIndex = values.findIndex(row => row.includes('Ticket ID') && row.includes('Appointment'));
  if (headerRowIndex < 0) throw new Error(`Could not find the header row in ${SOURCE_SHEET}`);
  const header = values[headerRowIndex];
  const missing = SOURCE_HEADERS.filter(name => !header.includes(name));
  if (missing.length) throw new Error(`Source sheet is missing expected headers: ${missing.join(', ')}`);
  const col = Object.fromEntries(SOURCE_HEADERS.map(name => [name, header.indexOf(name)]));

  const parseKey = value => {
    const p = rocket.parseDateParts(String(value || ''));
    return p ? `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}` : '';
  };
  const tickets = values.slice(headerRowIndex + 1)
    .filter(row => parseKey(row[col.Appointment]) === todayKey)
    .sort((a, b) => rocket.parseAppointmentTimestamp(a[col.Appointment]) - rocket.parseAppointmentTimestamp(b[col.Appointment]))
    .map(row => {
      const ticket = Object.fromEntries(SOURCE_HEADERS.map(name => [name, row[col[name]] || '']));
      const workType = isShopWork({
        branch: ticket.Branch,
        customer: ticket.Customer,
        problem: ticket['Problem Reported']
      }) ? 'Shop work' : 'On-site';
      return [...SOURCE_HEADERS.map(name => ticket[name]), workType];
    });
  const sheetId = await sheetsLib.ensureSheetExists(sheets, spreadsheetId, TARGET_SHEET);
  await sheetsLib.replaceSheetData(sheets, spreadsheetId, sheetId, TARGET_SHEET, TARGET_HEADERS, tickets);
  console.log(`Updated ${TARGET_SHEET} for ${todayKey}: ${tickets.length} appointments`);
}

main().catch(error => {
  console.error('On-site appointment sync failed:', error);
  process.exit(1);
});
