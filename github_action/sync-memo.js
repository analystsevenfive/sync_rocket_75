const rocket = require('./lib/rocket-client');
const sheetsLib = require('./lib/sheets-client');

const SHEET_NAME = 'Memo';
const HEADERS = [
  'เนื้อหา', 'รายละเอียด', 'จังหวัด', 'วันที่', 'Count Date',
  'ผู้ทำรายการ', 'วันที่ทำรายการ', 'เลขที่งาน', 'ช่าง', 'ป้ายทะเบียน', 'ไฟล์', 'ลิงก์ PDF', 'Last Sync'
];

const MONTHS = {
  มกราคม: 1, กุมภาพันธ์: 2, มีนาคม: 3, เมษายน: 4, พฤษภาคม: 5, มิถุนายน: 6,
  กรกฎาคม: 7, สิงหาคม: 8, กันยายน: 9, ตุลาคม: 10, พฤศจิกายน: 11, ธันวาคม: 12
};
const MONTH_PATTERN = Object.keys(MONTHS).join('|');
const DATE_RANGE = new RegExp(String.raw`(?<!\d)(\d{1,2})\s*(${MONTH_PATTERN})?\s*(\d{4})?\s*(?:[-–]|ถึง)\s*(?:วันที่\s*)?(\d{1,2})\s*(${MONTH_PATTERN})\s*(\d{4})`);
const DATE_SINGLE = new RegExp(String.raw`(?<!\d)(\d{1,2})\s*(${MONTH_PATTERN})\s*(\d{4})`);

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

function displayDate(key) {
  return `${key.slice(8)}/${key.slice(5, 7)}/${key.slice(0, 4)}`;
}

function splitProvince(detail) {
  const text = detail.replace(/วันที่/g, ' ');
  const provinces = [...text.matchAll(/(?:จ\.|จังหวัด)\s*([ก-๙]+(?:\s*[-–]\s*[ก-๙]+)*)/g)]
    .map(m => m[1].replace(/\s*[-–]\s*/g, '-'));
  if (provinces.length) return [...new Set(provinces)].join('-');
  const branch = text.match(/สาขา\s*([ก-๙]+)/);
  return branch ? `สาขา${branch[1]}` : '';
}

function splitDate(detail) {
  const range = detail.match(DATE_RANGE);
  const single = range ? null : detail.match(DATE_SINGLE);
  if (!range && !single) return { date: '', countDate: '' };
  const [, startText, startMonthName, startYearText, endText, endMonthName, yearText] =
    range || [null, single[1], single[2], single[3], single[1], single[2], single[3]];
  const toCE = y => (y > 2400 ? y - 543 : y);
  const start = Number(startText), end = Number(endText);
  const endMonth = MONTHS[endMonthName], endYear = toCE(Number(yearText));
  const startMonth = MONTHS[startMonthName || endMonthName];
  const startYear = startYearText ? toCE(Number(startYearText)) : endYear - (startMonth > endMonth ? 1 : 0);
  // ใช้ Date.UTC ซึ่งปัดวันเกินเดือนให้เอง: เมโมพิมพ์ "30-31 พฤศจิกายน" ยังนับได้ 2 วันตามที่เขียน
  const days = (Date.UTC(endYear, endMonth - 1, end) - Date.UTC(startYear, startMonth - 1, start)) / 86400000 + 1;
  const countDate = start >= 1 && end >= 1 && start <= 31 && end <= 31 && days >= 1 ? days : '';
  const date = !range ? `${start} ${endMonthName} ${yearText}`
    : !startMonthName || startMonthName === endMonthName ? `${start}-${end} ${endMonthName} ${yearText}`
    : `${start} ${startMonthName}${startYearText ? ` ${startYearText}` : ''} - ${end} ${endMonthName} ${yearText}`;
  return { date, countDate };
}

function splitDetails(value) {
  const detail = String(value || '').trim();
  return { province: splitProvince(detail), ...splitDate(detail) };
}

function splitTechniciansAndPlates(value) {
  const technicians = [];
  const plates = [];
  for (const line of String(value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
    const plate = line.match(/^(?:\d+[.)]?\s*)?(?:ทะเบียน\s*)?([ก-ฮ]{1,3}\s*\d{1,4})(?:\s*[-–]\s*(.*))?$/u);
    if (plate) {
      const registration = plate[1].replace(/\s+/g, '');
      const vehicle = (plate[2] || '').replace(/\s*ช่าง\s*$/, '').trim();
      plates.push(vehicle ? `${registration} - ${vehicle}` : registration);
    }
    else technicians.push(line);
  }
  return { technicians: technicians.join('\n'), plates: [...new Set(plates)].join('\n') };
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
  const from = displayDate(range.from);
  const to = displayDate(range.to);
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
    const people = splitTechniciansAndPlates(memo.technicians);
    return [memo.subject, memo.detail, parsed.province, parsed.date, parsed.countDate,
      memo.creator, memo.createdAt, memo.refs, people.technicians, people.plates,
      memo.file, memo.url, now];
  });
  const sheets = await sheetsLib.getSheetsClient();
  const sheetId = await sheetsLib.ensureSheetExists(sheets, spreadsheetId, SHEET_NAME);
  const summaryText = `ช่วงข้อมูล ${displayDate(range.from)} - ${displayDate(range.to)} | จำนวน ${rows.length.toLocaleString('en-US')} รายการ`;
  await sheetsLib.replaceSheetDataWithSummary(sheets, spreadsheetId, sheetId, SHEET_NAME, summaryText, HEADERS, rows);
  console.log(`Updated ${SHEET_NAME}: ${rows.length} rows (${summaryText})`);
}

if (require.main === module) main().catch(error => {
  console.error('Memo sync failed:', error);
  process.exit(1);
});

module.exports = { memoRange, splitDetails, splitTechniciansAndPlates, extractMemoRows, tableFromResponse };
