const rocket = require('./lib/rocket-client');
const sheetsLib = require('./lib/sheets-client');

const SHEET_NAME = 'Memo';
const HEADERS = [
  'เนื้อหา', 'รายละเอียด', 'จังหวัด', 'วันที่', 'Count Date',
  'ผู้ทำรายการ', 'วันที่ทำรายการ', 'เลขที่งาน', 'ช่าง', 'ไฟล์', 'URL', 'Last Sync'
];

const MONTHS = {
  มกราคม: 1, กุมภาพันธ์: 2, มีนาคม: 3, เมษายน: 4, พฤษภาคม: 5, มิถุนายน: 6,
  กรกฎาคม: 7, สิงหาคม: 8, กันยายน: 9, ตุลาคม: 10, พฤศจิกายน: 11, ธันวาคม: 12
};

function dateKey(value) {
  const p = rocket.parseDateParts(String(value || ''));
  return p ? `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}` : '';
}

function memoRange(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const part = type => Number(parts.find(p => p.type === type).value);
  const year = part('year'), month = part('month'), day = part('day');
  const previous = new Date(Date.UTC(year, month - 2, 1));
  const key = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { from: key(previous.getUTCFullYear(), previous.getUTCMonth() + 1, 1), to: key(year, month, day) };
}

function splitDetails(value) {
  const detail = String(value || '').trim();
  const province = detail.match(/(?:จ\.|จังหวัด)\s*([ก-๙]+)(?=\s|วันที่|$)/)?.[1] || '';
  const dateMatch = detail.match(/วันที่\s*(\d{1,2})(?:\s*[-–ถึง]+\s*(\d{1,2}))?\s*(มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)\s*(\d{4})/);
  if (!dateMatch) return { province, date: '', countDate: '' };
  const [, startText, endText, monthName, yearText] = dateMatch;
  const start = Number(startText), end = Number(endText || startText);
  const year = Number(yearText) > 2400 ? Number(yearText) - 543 : Number(yearText);
  const month = MONTHS[monthName];
  const valid = d => {
    const actual = new Date(Date.UTC(year, month - 1, d));
    return actual.getUTCFullYear() === year && actual.getUTCMonth() + 1 === month && actual.getUTCDate() === d;
  };
  const countDate = valid(start) && valid(end) && end >= start ? end - start + 1 : '';
  return { province, date: dateMatch[0].replace(/^วันที่\s*/, ''), countDate };
}

function extractMemoRows(html) {
  const rows = [];
  for (const tr of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
    if (cells.length < 5) continue;
    const creator = rocket.cleanText(cells[2]).split('\n').map(s => s.trim()).filter(Boolean);
    const createdAt = creator.find(s => dateKey(s)) || '';
    if (!createdAt) continue;
    const detail = rocket.cleanText(cells[1]);
    const refs = rocket.cleanText(cells[3]);
    const file = rocket.cleanText(cells[5] || '');
    const link = tr[1].match(/href=["']([^"']*memo[^"']*\.php\?[^"']+)["']/i)?.[1] || '';
    rows.push({ subject: rocket.cleanText(cells[0]), detail,
      creator: creator.filter(s => s !== createdAt).join(' '), createdAt,
      refs, technicians: rocket.cleanText(cells[4]), file,
      url: link ? new URL(link, `${rocket.ROCKET_BASE}/main/`).href : '' });
  }
  return rows;
}

function tableFromResponse(body) {
  try {
    const data = JSON.parse(body);
    if (Array.isArray(data)) return data.join('');
    const rows = data.data || data.aaData || data.html || data.result;
    if (typeof rows === 'string') return rows;
    if (Array.isArray(rows)) return rows.map(row => Array.isArray(row)
      ? `<tr>${row.map(cell => `<td>${cell || ''}</td>`).join('')}</tr>` : String(row)).join('');
  } catch (_) { /* HTML response */ }
  return body;
}

async function fetchMemoTable(auth, range) {
  const headers = { Cookie: auth.cookie, Origin: rocket.ROCKET_BASE,
    Referer: `${rocket.ROCKET_BASE}/main/memo_list.php`, 'X-Requested-With': 'XMLHttpRequest' };
  const pageRes = await rocket.fetchWithTimeout(`${rocket.ROCKET_BASE}/main/memo_list.php`, { headers });
  if (!pageRes.ok) throw new Error(`memo_list.php HTTP ${pageRes.status}`);
  const page = await pageRes.text();
  if (/<input\b[^>]*type=["']?password/i.test(page)) throw new Error('Rocket Memo login expired');
  const direct = extractMemoRows(page);

  const discovered = [...page.matchAll(/["']([^"']*ajax\/[^"']*memo[^"']*\.php)["']/gi)].map(m => m[1]);
  const candidates = [...new Set([...discovered,
    '/main/ajax/memo/getTable.php', '/main/ajax/memo_list/getTable.php'])];
  const from = range.from.slice(8) + '/' + range.from.slice(5, 7) + '/' + range.from.slice(0, 4);
  const to = range.to.slice(8) + '/' + range.to.slice(5, 7) + '/' + range.to.slice(0, 4);
  for (const path of candidates) {
    const body = new URLSearchParams({ token: auth.token, key: auth.key,
      start_date: from, end_date: to, status: 'x' });
    try {
      const response = await rocket.fetchWithTimeout(new URL(path, `${rocket.ROCKET_BASE}/main/`).href,
        { method: 'POST', headers, body });
      if (!response.ok) continue;
      const rows = extractMemoRows(tableFromResponse(await response.text()));
      if (rows.length) return rows;
    } catch (error) {
      console.log(`Memo table endpoint ${path} failed: ${error.message}`);
    }
  }
  if (direct.length) {
    const total = page.match(/Showing\s+\d+\s+to\s+\d+\s+of\s+(\d+)\s+records/i);
    if (!total || direct.length >= Number(total[1])) return direct;
  }
  throw new Error('No Memo rows could be read from Rocket; keeping previous sheet data');
}

async function main() {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('SPREADSHEET_ID is required');
  const range = memoRange();
  const auth = await rocket.rocketLogin();
  const memos = (await fetchMemoTable(auth, range)).filter(memo => {
    const key = dateKey(memo.createdAt);
    return key >= range.from && key <= range.to;
  });
  if (!memos.length) throw new Error(`No Memo rows in ${range.from} to ${range.to}; keeping previous sheet data`);
  const now = rocket.formatDateTimeBangkok(new Date());
  const rows = memos.map(memo => {
    const parsed = splitDetails(memo.detail);
    return [memo.subject, memo.detail, parsed.province, parsed.date, parsed.countDate,
      memo.creator, memo.createdAt, memo.refs, memo.technicians, memo.file, memo.url, now];
  });
  const sheets = await sheetsLib.getSheetsClient();
  const sheetId = await sheetsLib.ensureSheetExists(sheets, spreadsheetId, SHEET_NAME);
  await sheetsLib.replaceSheetData(sheets, spreadsheetId, sheetId, SHEET_NAME, HEADERS, rows);
  console.log(`Updated ${SHEET_NAME}: ${rows.length} rows (${range.from} to ${range.to})`);
}

if (require.main === module) main().catch(error => {
  console.error('Memo sync failed:', error);
  process.exit(1);
});

module.exports = { memoRange, splitDetails, extractMemoRows, tableFromResponse };
