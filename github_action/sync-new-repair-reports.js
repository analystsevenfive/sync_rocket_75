const rocket = require('./lib/rocket-client');
const sheetsLib = require('./lib/sheets-client');

const SOURCE_SHEET = 'Tickets';
const TARGET_SHEET = 'งานแจ้งซ่อมใหม่';

const HEADERS = [
  'Ticket ID', 'Ticket No', 'Report Date', 'Appointment', 'End Time',
  'Inspection Status', 'Active Stage', 'Status 1', 'Status 2', 'Status 3',
  'Sales Invoice No.', 'Customer', 'Branch', 'Customer Code', 'Contact',
  'Phone', 'Problem Reported', 'Product Code', 'Product Name', 'Technician',
  'Team', 'Serial', 'URL', 'Last Sync', 'งานshop/นอกสถานที่'
];

function isShopWork(ticket) {
  const text = [ticket.branch, ticket.customer, ticket.workDescription,
    ticket.machineLocation, ticket.problem].join(' ').toLowerCase();
  return /คลังสินค้า|ตึก\s*75|test\s*kitchen|warehouse|workshop|ศูนย์บริการ/.test(text);
}

async function main() {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('SPREADSHEET_ID is required');

  const sheets = await sheetsLib.getSheetsClient();
  const today = rocket.computeTodayRangeBangkok().dateParts;
  const todayKey = `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`;

  const source = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SOURCE_SHEET}'!A1:AJ`,
    valueRenderOption: 'FORMATTED_VALUE'
  });
  const values = source.data.values || [];
  const headerRowIndex = values.findIndex(row => row.includes('Ticket ID') && row.includes('Report Date'));
  if (headerRowIndex < 0) throw new Error(`Could not find the header row in ${SOURCE_SHEET}`);

  const header = values[headerRowIndex];
  const sourceColumns = [
    'Inspection Status', 'Sales Invoice No.', 'Ticket ID', 'Ticket No',
    'Status', 'Appointment', 'Report Date', 'Customer', 'Branch', 'Contact',
    'Phone', 'Problem Reported', 'Work Description', 'Machine Location',
    'Product Code', 'Product Name', 'Serial', 'End Time', 'Technician',
    'URL', 'Last Sync'
  ];
  const missing = sourceColumns.filter(name => !header.includes(name));
  if (missing.length) throw new Error(`Source sheet is missing expected headers: ${missing.join(', ')}`);
  const col = Object.fromEntries(sourceColumns.map(name => [name, header.indexOf(name)]));

  const reportDateKey = value => {
    const parsed = rocket.parseDateParts(String(value || ''));
    return parsed
      ? `${parsed.year}-${String(parsed.month).padStart(2, '0')}-${String(parsed.day).padStart(2, '0')}`
      : '';
  };

  const rows = values.slice(headerRowIndex + 1)
    .filter(row => reportDateKey(row[col['Report Date']]) === todayKey)
    .sort((a, b) => rocket.parseAppointmentTimestamp(a[col.Appointment]) - rocket.parseAppointmentTimestamp(b[col.Appointment]))
    .map(row => {
      const get = name => row[col[name]] || '';
      const status = get('Status');
      const item = {
        branch: get('Branch'), customer: get('Customer'),
        problem: get('Problem Reported'),
        workDescription: get('Work Description'),
        machineLocation: get('Machine Location')
      };
      return [
        get('Ticket ID'), get('Ticket No'), get('Report Date'), get('Appointment'),
        get('End Time'), get('Inspection Status'), '', status, '', '',
        get('Sales Invoice No.'), get('Customer'), get('Branch'), '',
        get('Contact'), get('Phone'), get('Problem Reported'), get('Product Code'),
        get('Product Name'), get('Technician'), '', get('Serial'), get('URL'),
        get('Last Sync'), isShopWork(item) ? 'Shop work' : 'On-site'
      ];
    });

  const sheetId = await sheetsLib.ensureSheetExists(sheets, spreadsheetId, TARGET_SHEET);
  await sheetsLib.replaceSheetData(sheets, spreadsheetId, sheetId, TARGET_SHEET, HEADERS, rows);
  console.log(`Updated ${TARGET_SHEET} from ${SOURCE_SHEET} Report Date for ${todayKey}: ${rows.length} rows`);
}

main().catch(error => {
  console.error('New repair report sync failed:', error);
  process.exit(1);
});
