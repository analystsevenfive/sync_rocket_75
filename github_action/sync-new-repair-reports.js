const rocket = require('./lib/rocket-client');
const sheetsLib = require('./lib/sheets-client');

const TARGET_SHEET = 'New Repair Reports';
const HEADERS = [
  'Ticket ID', 'Ticket No', 'Report Date', 'Appointment', 'End Time',
  'Inspection Status', 'Active Stage', 'Status 1', 'Status 2', 'Status 3',
  'Sales Invoice No.', 'Customer', 'Branch', 'Customer Code', 'Contact',
  'Phone', 'Problem Reported', 'Product Code', 'Product Name', 'Technician',
  'Team', 'Serial', 'URL', 'Last Sync', 'Shop / On-site Work'
];

function dateKey(value) {
  const parts = rocket.parseDateParts(String(value || ''));
  return parts ? `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}` : '';
}

function inputDateKey(value, fallback) {
  const input = String(value || '').trim();
  if (!input) return fallback;
  if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(input) && !/^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/.test(input)) {
    throw new Error(`Invalid Report Date "${input}"; use YYYY-MM-DD or DD/MM/YYYY`);
  }
  const key = dateKey(input);
  if (!key) throw new Error(`Invalid Report Date "${input}"`);
  const [year, month, day] = key.split('-').map(Number);
  const actual = new Date(Date.UTC(year, month - 1, day));
  if (actual.getUTCFullYear() !== year || actual.getUTCMonth() + 1 !== month || actual.getUTCDate() !== day) {
    throw new Error(`Invalid Report Date "${input}"`);
  }
  return key;
}

function extractParentRows(html) {
  const rows = [];
  const trRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = trRegex.exec(html)) !== null) {
    const idMatch = match[1].match(/ticket_view\.php\?id=(\d+)/i);
    if (!idMatch) continue;
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
    if (cells.length < 3) continue;
    const ticketNo = rocket.cleanText(cells[0]).match(/[A-Z]{2,4}\d{4}-\d+/i)?.[0] || '';
    const creatorLines = cells[1].split(/<br\s*\/?>/i).map(rocket.cleanText).filter(Boolean);
    const reportDate = creatorLines.find(line => dateKey(line)) || '';
    const customerMatch = cells[2].match(/fa-user[^>]*><\/i>([\s\S]*?)<\/label>/i);
    const branchMatch = cells[2].match(/fa-home[^>]*><\/i>([\s\S]*?)<\/label>/i);
    const statuses = [...(cells[4] || '').matchAll(/<(?:span|label|div|button|a)\b[^>]*class=["'][^"']*badge[^"']*["'][^>]*>([\s\S]*?)<\/(?:span|label|div|button|a)>/gi)]
      .map(m => rocket.cleanText(m[1])).filter(Boolean);
    rows.push({
      id: idMatch[1], ticketNo, reportDate,
      customer: customerMatch ? rocket.cleanText(customerMatch[1]).replace(/^\s*:\s*/, '') : '',
      branch: branchMatch ? rocket.cleanText(branchMatch[1]).replace(/^\s*:\s*/, '') : '',
      statuses
    });
  }
  return rows;
}

function forceTextIfNumeric(value) {
  const text = String(value || '').trim();
  return /^\d+$/.test(text) ? `'${text}` : text;
}

function shopWork(ticket) {
  const text = [ticket.branch, ticket.customer, ticket.workDescription,
    ticket.machineLocation, ticket.problem].join(' ').toLowerCase();
  return /คลังสินค้า|ตึก\s*75|test\s*kitchen|warehouse|workshop|ศูนย์บริการ/.test(text);
}

function reportRow(parent, overview, detail, assignment, inspection, customerCode, invoice, now) {
  const get = (name) => detail[name] || overview[name] || '';
  const ticket = {
    branch: get('branch') || parent.branch,
    customer: get('customer') || parent.customer,
    workDescription: get('workDescription'),
    machineLocation: detail.machineLocation || '',
    problem: get('problem')
  };
  return [
    detail.ticketId || parent.id, detail.ticketNo || parent.ticketNo,
    parent.reportDate, detail.appointment || '', detail.endTime || '',
    inspection.status || '', '', parent.statuses[0] || detail.status || '',
    parent.statuses[1] || '', parent.statuses[2] || '',
    forceTextIfNumeric(invoice), ticket.customer, ticket.branch,
    forceTextIfNumeric(detail.customerCode || customerCode), get('contact'),
    forceTextIfNumeric(get('phone')), ticket.problem,
    forceTextIfNumeric(get('productCode')), get('productName'),
    assignment.technicians || detail.technician || '', assignment.team || '',
    forceTextIfNumeric(get('serial')),
    detail.url || `${rocket.ROCKET_BASE}/main/ticket_view.php?id=${parent.id}`,
    now, shopWork(ticket) ? 'Shop work' : 'On-site'
  ];
}

async function main() {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('SPREADSHEET_ID is required');

  const today = rocket.computeTodayRangeBangkok().dateParts;
  const todayKey = `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`;
  const dateFrom = inputDateKey(process.env.REPORT_DATE_FROM, todayKey);
  const dateTo = inputDateKey(process.env.REPORT_DATE_TO, dateFrom);
  if (dateFrom > dateTo) throw new Error('Report Date start must be on or before end date');

  const auth = await rocket.rocketLogin();
  const toRocketDate = key => key.slice(8, 10) + '/' + key.slice(5, 7) + '/' + key.slice(0, 4);
  const html = await rocket.getParentTicketHtml(auth, toRocketDate(dateFrom), toRocketDate(dateTo), '1');
  const parents = extractParentRows(html).filter(ticket => {
    const key = dateKey(ticket.reportDate);
    return key >= dateFrom && key <= dateTo;
  });
  if (!parents.length && rocket.extractParentTicketIds(html).length) {
    throw new Error('Rocket returned tickets, but none had a readable Report Date in the requested range');
  }

  const customerCodes = rocket.extractParentToCustomerCodeMap(html);
  const productIds = rocket.extractParentToProductIdMap(html);
  const parentData = await rocket.mapConcurrentStrict(parents, 15, async parent => {
    const [overviewHtml, checkRepairHtml] = await Promise.all([
      rocket.getOverviewHtml(parent.id, auth),
      rocket.getCheckRepairHtml(parent.id, auth)
    ]);
    const subIds = rocket.extractCheckRepairIds(checkRepairHtml);
    const assignments = rocket.extractCheckRepairInfo(checkRepairHtml);
    const details = await rocket.mapConcurrentStrict(subIds, 10, async subId => {
      const detailHtml = await rocket.getTicketDetailHtml(subId, auth);
      const detail = rocket.parseTicketDetail(detailHtml, subId);
      const inspection = rocket.parseInspectorModal(await rocket.getInspectorModalHtml(subId, auth));
      return { detail, inspection, assignment: assignments[subId] || {} };
    });
    let invoice = '';
    const productId = productIds[parent.id];
    if (productId) invoice = rocket.parseSalesInvoiceNo(await rocket.getModalProductHtml(productId, auth));
    return { parent, overview: rocket.parseOverviewHtml(overviewHtml), details, invoice };
  });
  const now = rocket.formatDateTimeBangkok(new Date());
  const rows = parentData.flatMap(({ parent, overview, details, invoice }) => {
    const records = details.length ? details : [{ detail: {}, inspection: {}, assignment: {} }];
    return records.map(({ detail, inspection, assignment }) => reportRow(
      parent, overview, detail, assignment, inspection,
      customerCodes[parent.id] || '', invoice, now
    ));
  });
  const sheets = await sheetsLib.getSheetsClient();
  const sheetId = await sheetsLib.ensureSheetExists(sheets, spreadsheetId, TARGET_SHEET);
  await sheetsLib.replaceSheetData(sheets, spreadsheetId, sheetId, TARGET_SHEET, HEADERS, rows);
  console.log(`Updated ${TARGET_SHEET} from Rocket Report Date for ${dateFrom} to ${dateTo}: ${rows.length} rows`);
}

if (require.main === module) main().catch(error => {
  console.error('New repair report sync failed:', error);
  process.exit(1);
});

module.exports = { dateKey, inputDateKey, extractParentRows, reportRow };
