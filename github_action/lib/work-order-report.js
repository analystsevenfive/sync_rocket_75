const XLSX = require('xlsx');
const rocket = require('./rocket-client');

function parseWorkOrderSentReport(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error('Work order report contains no worksheet');
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const header = rows.find(row => row.some(cell => String(cell).trim() === 'เลขที่ใบงาน'));
  if (!header) throw new Error('Work order report is missing ticket number header');
  const ticketColumn = header.findIndex(cell => String(cell).trim() === 'เลขที่ใบงาน');
  const sentColumn = header.findIndex(cell => String(cell).trim() === 'วันที่ส่งใบงาน');
  if (sentColumn < 0) throw new Error('Work order report is missing sent date header');

  const sentByTicket = new Map();
  for (const row of rows.slice(rows.indexOf(header) + 1)) {
    const ticketNo = String(row[ticketColumn] || '').trim().toUpperCase();
    if (!/^[A-Z]{2,4}[A-Z0-9-]+\.[A-Z0-9]+$/.test(ticketNo)) continue;
    const value = String(row[sentColumn] || '').trim();
    if (!sentByTicket.has(ticketNo) || value) sentByTicket.set(ticketNo, value);
  }
  return sentByTicket;
}

async function getWorkOrderSentReport(auth, startDate, endDate) {
  const body = new URLSearchParams({
    status: '', start_date: startDate, end_date: endDate,
    search_team: 'x', search_staff: 'x', search_area: 'x'
  });
  const response = await rocket.fetchWithTimeout(
    rocket.ROCKET_BASE + '/main/ajax/report_ticket/check_ticket/export_check_ticket.php',
    {
      method: 'POST',
      headers: {
        Cookie: auth.cookie,
        Origin: rocket.ROCKET_BASE,
        Referer: rocket.ROCKET_BASE + '/main/report_check_ticket.php'
      },
      body
    },
    120000
  );
  if (!response.ok) throw new Error('Work order report HTTP ' + response.status);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.subarray(0, 2).toString() !== 'PK') {
    throw new Error('Work order report did not return an Excel file');
  }
  return parseWorkOrderSentReport(buffer);
}

module.exports = { parseWorkOrderSentReport, getWorkOrderSentReport };
