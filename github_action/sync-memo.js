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
let memoDiagnosticLogged = false;

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
  const province = detail.match(/(?:จ\.|จังหวัด)\s*([ก-๙]+(?:\s*[-–]\s*[ก-๙]+)*)(?=\s|วันที่|$)/)?.[1].replace(/\s*[-–]\s*/g, '-') || '';
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
    const pdfUrl = links.find(link => /(?:memo_print|print_memo|memo_pdf)\.php\?|\.pdf(?:\?|$)/i.test(link)) || '';
    rows.push({ subject: rocket.cleanText(cells[0]), detail,
      creator: creator.filter(s => s !== createdAt).join(' '), createdAt,
      refs, technicians: rocket.cleanText(cells[4]), file,
      url: editUrl || pdfUrl, pdfUrl });
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

function memoEndpointHints(html) {
  const values = [];
  const text = String(html || '').replace(/&amp;/gi, '&');
  for (const match of text.matchAll(/["']([^"'<>]*(?:\.php|\.pdf|print|download|file)[^"'<>]*)["']/gi)) {
    const value = match[1].trim().replace(/([?&][^=&]+)=([^&#\s]*)/g, '$1=<redacted>');
    if (value && value.length < 300 && !values.includes(value)) values.push(value);
  }
  return values.slice(0, 80);
}

function memoFileFieldHints(html) {
  const hints = [];
  for (const match of String(html || '').matchAll(/<input\b[^>]*(?:memo_file_existing|memo_file_name|\bname=["']memo_file["'])[^>]*>/gi)) {
    const tag = match[0];
    const key = tag.match(/(?:id|name)=["']([^"']+)["']/i)?.[1] || 'memo_file';
    const value = tag.match(/value=["']([^"']*)["']/i)?.[1] || '';
    const safeValue = value.replace(/[^/\\]+(?=\.[a-z0-9]{2,6}(?:\?|$))/i, '<file>');
    hints.push({ key, value: safeValue });
  }
  return hints;
}

function memoApprovalHints(html) {
  const text = String(html || '');
  const fieldNames = [...text.matchAll(/<(?:input|select|textarea)\b[^>]*(?:name|id)=["']([^"']+)["'][^>]*>/gi)]
    .map(match => match[1])
    .filter(name => /approv|confirm|status|user|staff|boss|head/i.test(name));
  const labels = [...text.matchAll(/.{0,100}(?:อนุมัติ|ผู้อนุมัติ|approve|approval|confirm).{0,140}/gi)]
    .map(match => rocket.cleanText(match[0]).replace(/\b\d{6,}\b/g, '<id>'))
    .filter(Boolean);
  return { fieldNames: [...new Set(fieldNames)].slice(0, 50), labels: [...new Set(labels)].slice(0, 20) };
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
  const candidates = [];
  const add = values => values.filter(Boolean).forEach(value => {
    if (!candidates.includes(value)) candidates.push(value);
  });
  add([memo.pdfUrl]);

  if (memo.url) {
    add([
      memo.url.replace(/memo_edit\.php/i, 'memo_print.php'),
      memo.url.replace(/memo_edit\.php/i, 'print_memo.php')
    ]);
    try {
      const detail = await rocket.fetchWithTimeout(memo.url, { headers });
      if (detail.ok) {
        const html = await detail.text();
        add(memoPdfCandidates(html, memo.url));
        if (!memoDiagnosticLogged) {
          memoDiagnosticLogged = true;
          console.log('Memo detail endpoint hints: ' + JSON.stringify(memoEndpointHints(html)));
          console.log('Memo file field hints: ' + JSON.stringify(memoFileFieldHints(html)));
          console.log('Memo approval hints: ' + JSON.stringify(memoApprovalHints(html)));
        }
      }
    } catch (error) {
      console.log(`Memo detail lookup failed for ${memo.url}: ${error.message}`);
    }
  }

  for (let i = 0; i < candidates.length; i++) {
    const url = candidates[i];
    try {
      const response = await rocket.fetchWithTimeout(url, { headers: { ...headers, Referer: memo.url || headers.Referer } });
      if (!response.ok) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
        return APPROVAL_LABELS[await checkApproval(buffer)];
      }
      const contentType = String(response.headers.get('content-type') || '');
      if (/html|text/i.test(contentType) || buffer.subarray(0, 1).toString() === '<') {
        add(memoPdfCandidates(buffer.toString('utf8'), url));
      }
    } catch (error) {
      console.log(`Memo PDF candidate failed for ${url}: ${error.message}`);
    }
  }
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
  tableFromResponse, memoPdfCandidates };
