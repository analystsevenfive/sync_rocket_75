const rocket = require('./lib/rocket-client');
const sheetsLib = require('./lib/sheets-client');
const { checkApproval } = require('./lib/memo-approval');

const SHEET_NAME = 'Memo';
const HEADERS = [
  'เนื้อหา', 'รายละเอียด', 'จังหวัด', 'วันที่', 'Count Date',
  'ผู้ทำรายการ', 'วันที่ทำรายการ', 'เลขที่งาน', 'ช่าง', 'ป้ายทะเบียน', 'ไฟล์', 'ลิงก์ PDF', 'สถานะอนุมัติ', 'ผู้อนุมัติ', 'Last Sync'
];
const APPROVED = 'อนุมัติแล้ว';
const APPROVAL_LABELS = { approved: APPROVED, 'other-sender': 'สติกเกอร์จากคนอื่น', 'no-sticker': 'ไม่พบสติกเกอร์' };
const APPROVER = 'คุณวิรัตน์'; // ยืนยันจากรูปโปรไฟล์ Virat 75 ข้างสติกเกอร์

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
  const province = detail.match(/(?:จ\.|จังหวัด)\s*([ก-๙]+(?:\s*[-–]\s*[ก-๙]+)*)(?=\s|วันที่|$)/)?.[1].replace(/\s*[-–]\s*/g, '-')
    || detail.match(/สาขา\s*([ก-๙]+)/)?.[1] || '';
  const M = Object.keys(MONTHS).join('|');
  // D[-D] Month YYYY, or cross-month: D Month [YYYY] ถึง/- [YYYY] D Month YYYY; "วันที่" prefix optional
  const dateRe = new RegExp(`(?:วันที่\\s*)?(\\d{1,2})\\s*(?:(${M})\\s*(\\d{4})?\\s*)?(?:(?:-|–|ถึง)\\s*(?:\\d{4}\\s+)?(\\d{1,2})\\s*)?(${M})\\s*(\\d{4})`);
  const dateMatch = detail.match(dateRe);
  if (!dateMatch) return { province, date: '', countDate: '' };
  const [raw, startText, startMonthName, startYearText, endText, endMonthName, endYearText] = dateMatch;
  const toAd = y => (y > 2400 ? y - 543 : y);
  const endYear = toAd(Number(endYearText)), endMonth = MONTHS[endMonthName];
  const startMonth = startMonthName ? MONTHS[startMonthName] : endMonth;
  const startYear = startYearText ? toAd(Number(startYearText)) : (startMonth > endMonth ? endYear - 1 : endYear);
  const start = Number(startText), end = Number(endText || startText);
  const toDate = (y, m, d) => {
    const actual = new Date(Date.UTC(y, m - 1, d));
    return actual.getUTCMonth() + 1 === m && actual.getUTCDate() === d ? actual : null;
  };
  const from = toDate(startYear, startMonth, start), to = toDate(endYear, endMonth, end);
  const countDate = from && to && to >= from ? Math.round((to - from) / 86400000) + 1 : '';
  const date = startMonthName && endText
    ? `${start} ${startMonthName}${startYearText && startYearText !== endYearText ? ` ${startYearText}` : ''} - ${end} ${endMonthName} ${endYearText}`
    : raw.replace(/^วันที่\s*/, '');
  return { province, date, countDate };
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
    const links = [...tr[1].matchAll(/href=["']([^"']+)["']/gi)]
      .map(match => new URL(match[1], `${rocket.ROCKET_BASE}/main/`).href);
    const editUrl = links.find(link => /memo_edit\.php\?/i.test(link)) || '';
    const pdfUrl = links.find(link => /(?:75_memo|memo_print|print_memo|memo_pdf)\.php\?|\.pdf(?:\?|$)/i.test(link)) || '';
    const memoId = editUrl.match(/[?&]id=([^&#]+)/i)?.[1] || '';
    const printUrl = memoId
      ? `${rocket.ROCKET_BASE}/print/75_memo.php?id=${encodeURIComponent(decodeURIComponent(memoId))}` : pdfUrl;
    rows.push({ subject: rocket.cleanText(cells[0]), detail,
      creator: creator.filter(s => s !== createdAt).join(' '), createdAt,
      refs, technicians: rocket.cleanText(cells[4]), file,
      url: printUrl, editUrl, pdfUrl: printUrl });
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

function memoPdfCandidates(html, baseUrl) {
  const values = [];
  const decoded = String(html || '').replace(/&amp;/gi, '&');
  for (const match of decoded.matchAll(/(?:href|src|action)\s*=\s*["']([^"']+)["']/gi)) {
    values.push(match[1]);
  }
  for (const match of decoded.matchAll(/["']([^"'<>]*(?:memo[^"'<>]*print|print[^"'<>]*memo|\.pdf(?:\?[^"'<>]*)?)[^"'<>]*)["']/gi)) {
    values.push(match[1]);
  }
  return [...new Set(values.filter(value => /(?:print|pdf)/i.test(value)).map(value => {
    try { return new URL(value, baseUrl).href; } catch (_) { return ''; }
  }).filter(Boolean))];
}

function memoApprovalEvidenceCandidates(html, baseUrl) {
  const text = String(html || '');
  const evidenceAt = text.indexOf('หลักฐานการอนุมัติที่มีอยู่');
  if (evidenceAt < 0) return [];
  const evidence = text.slice(evidenceAt, evidenceAt + 10000);
  return [...new Set([...evidence.matchAll(/(?:href|src)=["']([^"']+\.(?:jpe?g|png|webp)(?:\?[^"']*)?)["']/gi)]
    .map(match => {
      try { return new URL(match[1].replace(/&amp;/gi, '&'), baseUrl).href; } catch (_) { return ''; }
    }).filter(Boolean))];
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

async function approvalStatus(memo, auth) {
  const headers = { Cookie: auth.cookie, Referer: `${rocket.ROCKET_BASE}/main/memo_list.php` };
  const detailUrl = memo.editUrl || memo.url;
  const candidates = [];
  const add = values => values.filter(Boolean).forEach(value => {
    if (!candidates.includes(value)) candidates.push(value);
  });
  add([memo.pdfUrl]);
  let imageResult = 'no-sticker';

  if (detailUrl) {
    add([
      detailUrl.replace(/memo_edit\.php/i, 'memo_print.php'),
      detailUrl.replace(/memo_edit\.php/i, 'print_memo.php')
    ]);
    try {
      const detail = await rocket.fetchWithTimeout(detailUrl, { headers });
      if (detail.ok) {
        const html = await detail.text();
        add(memoPdfCandidates(html, detailUrl));
        add(memoApprovalEvidenceCandidates(html, detailUrl));
      }
    } catch (error) {
      console.log(`Memo detail lookup failed for ${detailUrl}: ${error.message}`);
    }
  }

  for (let i = 0; i < candidates.length; i++) {
    const url = candidates[i];
    try {
      const response = await rocket.fetchWithTimeout(url, { headers: { ...headers, Referer: detailUrl || headers.Referer } });
      if (!response.ok) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
        return APPROVAL_LABELS[await checkApproval(buffer)];
      }
      const contentType = String(response.headers.get('content-type') || '');
      if (/^image\//i.test(contentType) || /^\xFF\xD8/.test(buffer.subarray(0, 2).toString('latin1')) ||
          buffer.subarray(0, 8).toString('latin1') === '\x89PNG\r\n\x1a\n') {
        const result = await checkApproval(buffer);
        if (result === 'approved') return APPROVAL_LABELS.approved;
        if (result === 'other-sender') imageResult = result;
        continue;
      }
      if (/html|text/i.test(contentType) || buffer.subarray(0, 1).toString() === '<') {
        add(memoPdfCandidates(buffer.toString('utf8'), url));
      }
    } catch (error) {
      console.log(`Memo PDF candidate failed for ${url}: ${error.message}`);
    }
  }
  if (candidates.some(url => /\.(?:jpe?g|png|webp)(?:\?|$)/i.test(url))) return APPROVAL_LABELS[imageResult];
  console.log(`No PDF could be resolved for Memo ${memo.url || '(no URL)'}`);
  return 'ตรวจไม่ได้';
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
  const rows = [];
  for (const memo of memos) {
    const parsed = splitDetails(memo.detail);
    const people = splitTechniciansAndPlates(memo.technicians);
    const status = await approvalStatus(memo, auth);
    rows.push([memo.subject, memo.detail, parsed.province, parsed.date, parsed.countDate,
      memo.creator, memo.createdAt, memo.refs, people.technicians, people.plates,
      memo.file, memo.url, status, status === APPROVED ? APPROVER : '', now]);
  }
  const approvalCounts = rows.reduce((counts, row) => {
    counts[row[12]] = (counts[row[12]] || 0) + 1;
    return counts;
  }, {});
  console.log('Memo approval summary: ' + JSON.stringify(approvalCounts));
  const sheets = await sheetsLib.getSheetsClient();
  const sheetId = await sheetsLib.ensureSheetExists(sheets, spreadsheetId, SHEET_NAME);
  const summary = `Memo | ช่วงข้อมูล ${range.from} - ${range.to} | ` +
    `จำนวน ${rows.length.toLocaleString('en-US')} รายการ | Last Sync ${now}`;
  await sheetsLib.replaceSheetDataWithSummary(
    sheets, spreadsheetId, sheetId, SHEET_NAME, summary, HEADERS, rows
  );
  console.log(`Updated ${SHEET_NAME}: ${rows.length} rows (${range.from} to ${range.to})`);
}

if (require.main === module) main().catch(error => {
  console.error('Memo sync failed:', error);
  process.exit(1);
});

module.exports = { memoRange, splitDetails, splitTechniciansAndPlates, extractMemoRows,
  tableFromResponse, memoPdfCandidates, memoApprovalEvidenceCandidates };
