/*************************************************
 * SYNC EMPLOYEE WORKING
 *
 * ดึงรายชื่อพนักงานที่ทำงานอยู่จาก /hr/employee_list.php
 * (POST /hr/ajax/employee/getTable.php) แล้วอ่านข้อมูลส่วนตัวรายคนจาก
 * /hr/ajax/employee_view/Get_Position.php เขียนลงชีท Employee Working
 * แบบ snapshot พร้อมรูปด้วย =IMAGE() — รูปอยู่ที่ /images/ ซึ่งเปิดได้
 * โดยไม่ต้อง login จึงไม่ต้องอัปโหลดไป Drive
 *
 * Get_Position.php คืนใบสมัครงานทั้งฉบับ แต่ sync เฉพาะ DETAIL_FIELDS
 * (ไม่เอาส่วนสุขภาพ/คำพิพากษา/ประวัติเลิกจ้าง)
 *
 * ชีทนี้มีข้อมูลส่วนบุคคล: ห้าม console.log ค่าของพนักงาน log เฉพาะจำนวนแถว
 *************************************************/

const rocket = require('../github_action/lib/rocket-client');
const sheetsLib = require('../github_action/lib/sheets-client');

const SHEET_NAME = 'Employee Working';
const REFERER = `${rocket.ROCKET_BASE}/hr/employee_list.php`;
const DETAIL_FIELDS = [
  'คำนำหน้า (ไทย)', 'ชื่อ (ไทย)', 'สกุล (ไทย)', 'คำนำหน้า (อังกฤษ)', 'ชื่อ (อังกฤษ)', 'สกุล (อังกฤษ)',
  'ชื่อเล่น', 'เลขบัตรประชาชน', 'เพศ', 'อายุ', 'วันเกิด', 'สถานที่เกิด', 'สัญชาติ', 'เชื้อชาติ', 'ศาสนา',
  'ส่วนสูง', 'น้ำหนัก', 'กรุ๊ปเลือด', 'ตำหนิ', 'สายตา',
  'ที่อยู่ตามทะเบียนบ้าน', 'ที่อยู่ปัจจุบัน',
  'โทรศัพท์บ้าน', 'โทรศัพท์มือถือ', 'อีเมล', 'ผู้ติดต่อฉุกเฉิน', 'ความสัมพันธ์', 'เบอร์โทรผู้ติดต่อฉุกเฉิน'
];
const HEADERS = [
  'รูป', 'ลิงก์รูป', 'รหัสพนักงาน', 'ชื่อ-สกุล', 'วันที่เริ่มงาน', 'อายุงาน',
  'รหัสตำแหน่ง', 'ตำแหน่ง', 'แผนก', 'บริษัท', 'เลเวล', 'สถานะ',
  ...DETAIL_FIELDS, 'User ID', 'Last Sync'
];
const PHOTO_ROW_PIXELS = 80;
const DETAIL_CONCURRENCY = 4;

function lineValue(lines, label) {
  const line = lines.find(s => s.startsWith(label));
  return line ? line.slice(label.length).replace(/^\s*:\s*/, '').trim() : '';
}

function cellLines(html) {
  // ตารางนี้ใช้ทั้ง <br> และ </br> แต่ cleanText รู้จักแค่ <br>
  return rocket.cleanText(String(html).replace(/<\/br\s*>/gi, '<br>'))
    .split('\n').map(s => s.trim()).filter(Boolean);
}

function parseEmployeeList(html) {
  const employees = [];
  // แถบ status มี badge เก่าค้างใน comment ต้องลบก่อนอ่าน cell
  const source = String(html).replace(/<!--[\s\S]*?-->/g, '');
  for (const tr of source.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
    if (cells.length < 7) continue;
    const userId = tr[1].match(/employee_view\.php\?user_id=(\d+)/)?.[1];
    const employeeId = rocket.cleanText(cells[1]);
    if (!userId || !employeeId) continue;

    const photo = cells[0].match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i)?.[1] || '';
    const detail = cellLines(cells[3]);
    const position = cellLines(cells[4]);
    const title = (position[0] || '').match(/^(\S+)\s+-\s+(.*)$/);
    employees.push({
      userId, employeeId,
      photoUrl: photo ? new URL(photo, `${rocket.ROCKET_BASE}/hr/`).href : '',
      fullName: rocket.cleanText(cells[2]),
      phone: lineValue(detail, 'เบอร์โทร'),
      email: lineValue(detail, 'อีเมล'),
      startDate: lineValue(detail, 'วันที่เริ่มงาน'),
      tenure: detail.find(s => /^\d+\s*ปี/.test(s)) || '',
      positionCode: title ? title[1] : '',
      position: title ? title[2].trim() : (position[0] || ''),
      department: lineValue(position, 'แผนก'),
      company: lineValue(position, 'บริษัท'),
      level: position.join(' ').match(/Lv\.?\s*([\w.]+)/i)?.[1] || '',
      status: rocket.cleanText(cells[5])
    });
  }
  return employees;
}

function parseEmployeeDetail(html) {
  const detail = {};
  const source = String(html).replace(/<!--[\s\S]*?-->/g, '');
  const pair = /<div class="profile-label">([\s\S]*?)<\/div>\s*<div class="profile-value">([\s\S]*?)<\/div>/gi;
  for (const match of source.matchAll(pair)) {
    detail[rocket.cleanText(match[1])] = rocket.cleanText(match[2]);
  }
  return detail;
}

function parseDetailPhotoUrl(html) {
  const photo = String(html).match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i)?.[1];
  return photo ? new URL(photo, `${rocket.ROCKET_BASE}/hr/`).href : '';
}

// รูปยืนยันตัวตนได้ก็ต่อเมื่อเป็นของคนนี้คนเดียว: รูป default ที่หลายคนใช้ร่วมกันไม่นับ
function sharedPhotoUrls(employees) {
  const seen = new Set();
  const shared = new Set();
  for (const { photoUrl } of employees) {
    if (seen.has(photoUrl)) shared.add(photoUrl);
    seen.add(photoUrl);
  }
  return shared;
}

// กันเขียนข้อมูลผิดคน: ถ้า endpoint คืนของบัญชีที่ login แทน user_id ที่ขอ
// หรือหน้าเปลี่ยนรูปแบบ ต้องหยุดทั้งรอบ ไม่ใช่เขียนทับชีท
// ชื่อในหน้า list กับ detail อาจต่างกันได้ (เช่นสะกดคนละแบบ) จึงยอมรับรูปที่ตรงกันเป็นหลักฐานแทน
// คืน false เมื่อ detail ไม่มีชื่อเลยและไม่มีรูปยืนยัน (ประวัติยังกรอกไม่ครบ): ไม่ใช่ข้อมูลผิดคน
// ไม่ต้องหยุดทั้งรอบ แต่ห้ามเขียนค่าที่ยืนยันเจ้าของไม่ได้ลงชีท
// error ห้ามมีค่าจาก detail เพราะข้อความไปอยู่ใน log ของ GitHub Actions
function verifyDetail(employee, detail, photoConfirmed = false) {
  const missing = DETAIL_FIELDS.filter(label => !(label in detail));
  if (missing.length) {
    throw new Error(`Detail for ${employee.employeeId} is missing fields: ${missing.join(', ')}`);
  }
  const compact = value => String(value || '').replace(/\s+/g, '').toLowerCase();
  const listName = compact(employee.fullName);
  const nameState = label => {
    const name = compact(detail[label]);
    if (!name) return 'blank';
    return listName.includes(name) ? 'same' : 'different';
  };
  const thai = nameState('ชื่อ (ไทย)');
  const english = nameState('ชื่อ (อังกฤษ)');
  if (thai === 'same' || english === 'same' || photoConfirmed) return true;
  if (thai === 'blank' && english === 'blank') return false;
  throw new Error(`Detail for ${employee.employeeId} does not match the requested employee ` +
    `(thai=${thai}, english=${english}, photo=${employee.photoUrl ? 'different' : 'none'})`);
}

// เขียนแบบ USER_ENTERED เพราะ =IMAGE() ต้องเป็นสูตร ค่าข้อมูลจึงต้องขึ้นต้นด้วย '
// ไม่งั้น Sheets ตัด 0 นำหน้าของรหัส/เบอร์ และแปลงวันที่ตาม locale ของไฟล์
function asText(value) {
  const text = String(value == null ? '' : value);
  return text ? `'${text}` : '';
}

function photoFormula(url) {
  return url ? `=IMAGE("${url.replace(/"/g, '""')}")` : '';
}

function toRow(employee, detail, syncedAt) {
  // หน้า list มักไม่มีเบอร์/อีเมล แต่หน้า detail มี จึงใช้ detail เป็นหลัก
  const merged = Object.assign({}, detail, {
    'โทรศัพท์มือถือ': detail['โทรศัพท์มือถือ'] || employee.phone,
    'อีเมล': detail['อีเมล'] || employee.email
  });
  return [
    photoFormula(employee.photoUrl),
    employee.photoUrl, // ไม่ผ่าน asText: ให้ Sheets ทำเป็นลิงก์กดได้ และเป็น https:// เสมอ
    ...[employee.employeeId, employee.fullName, employee.startDate, employee.tenure,
      employee.positionCode, employee.position, employee.department, employee.company,
      employee.level, employee.status,
      ...DETAIL_FIELDS.map(label => merged[label]),
      employee.userId, syncedAt].map(asText)
  ];
}

async function fetchEmployeeList(auth) {
  const body = new URLSearchParams({
    name_search: '', search_area: 'x', search_department: 'x', search_division: 'x',
    search_level: 'x', search_position: 'x', token: auth.token, key: auth.key,
    search_status: '1', search_user_status: '1', search_resign_year: 'x'
  });
  const response = await rocket.fetchWithTimeout(`${rocket.ROCKET_BASE}/hr/ajax/employee/getTable.php`, {
    method: 'POST', body,
    headers: { Cookie: auth.cookie, Origin: rocket.ROCKET_BASE, Referer: REFERER, 'X-Requested-With': 'XMLHttpRequest' }
  });
  if (!response.ok) throw new Error(`employee getTable.php HTTP ${response.status}`);
  return response.text();
}

async function fetchEmployeeDetail(auth, userId) {
  const response = await rocket.fetchWithTimeout(`${rocket.ROCKET_BASE}/hr/ajax/employee_view/Get_Position.php`, {
    method: 'POST', body: new URLSearchParams({ user_id: userId }),
    headers: { Cookie: auth.cookie, Origin: rocket.ROCKET_BASE,
      Referer: `${rocket.ROCKET_BASE}/hr/employee_view.php?user_id=${userId}`, 'X-Requested-With': 'XMLHttpRequest' }
  });
  if (!response.ok) throw new Error(`employee Get_Position.php HTTP ${response.status}`);
  const html = await response.text();
  return { detail: parseEmployeeDetail(html), photoUrl: parseDetailPhotoUrl(html) };
}

async function setPhotoRowHeight(sheets, spreadsheetId, sheetId, rowCount) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        { updateDimensionProperties: {
          range: { sheetId, dimension: 'ROWS', startIndex: 2, endIndex: 2 + rowCount },
          properties: { pixelSize: PHOTO_ROW_PIXELS }, fields: 'pixelSize' } },
        { updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
          properties: { pixelSize: PHOTO_ROW_PIXELS }, fields: 'pixelSize' } }
      ]
    }
  });
}

async function main() {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('SPREADSHEET_ID is required');

  const auth = await rocket.rocketLogin();
  const employees = parseEmployeeList(await fetchEmployeeList(auth));
  if (!employees.length) throw new Error('No employee rows could be read from Rocket; keeping previous sheet data');

  // ส่งแค่ index เพราะ mapConcurrentStrict พิมพ์ item ลง error message ตอนล้มเหลว
  const indexes = employees.map((_, i) => i);
  const sharedPhotos = sharedPhotoUrls(employees);
  const withoutProfile = [];
  const details = await rocket.mapConcurrentStrict(indexes, DETAIL_CONCURRENCY, async i => {
    const employee = employees[i];
    const { detail, photoUrl } = await fetchEmployeeDetail(auth, employee.userId);
    const photoConfirmed = Boolean(photoUrl) && photoUrl === employee.photoUrl && !sharedPhotos.has(photoUrl);
    if (verifyDetail(employee, detail, photoConfirmed)) return detail;
    withoutProfile.push(employee.employeeId);
    return {};
  });
  if (withoutProfile.length) {
    console.log(`No verifiable profile, wrote list data only: ${withoutProfile.join(', ')}`);
  }

  const now = rocket.formatDateTimeBangkok(new Date());
  const rows = employees.map((employee, i) => toRow(employee, details[i], now));
  const sheets = await sheetsLib.getSheetsClient();
  const sheetId = await sheetsLib.ensureSheetExists(sheets, spreadsheetId, SHEET_NAME);
  const summaryText = `ข้อมูล ณ ${now} | พนักงานที่ทำงานอยู่ ${rows.length.toLocaleString('en-US')} คน`;
  await sheetsLib.replaceSheetDataWithSummary(sheets, spreadsheetId, sheetId, SHEET_NAME, summaryText, HEADERS, rows);
  await setPhotoRowHeight(sheets, spreadsheetId, sheetId, rows.length);
  console.log(`Updated ${SHEET_NAME}: ${rows.length} rows`);
}

if (require.main === module) main().catch(error => {
  console.error('Employee Working sync failed:', error.message);
  process.exit(1);
});

module.exports = {
  parseEmployeeList, parseEmployeeDetail, parseDetailPhotoUrl, sharedPhotoUrls, verifyDetail,
  asText, photoFormula, toRow, HEADERS, DETAIL_FIELDS
};
