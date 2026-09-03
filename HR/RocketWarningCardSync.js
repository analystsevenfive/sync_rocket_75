/**
 * Rocket75 — ใบเตือน -> Google Sheets
 *
 * Script Properties ที่ต้องมี:
 *   ROCKET_USERNAME = ชื่อผู้ใช้ rocket75.com
 *   ROCKET_PASSWORD = รหัสผ่าน rocket75.com
 *
 * รัน syncRocketWarningCard() ด้วยตนเองเพื่อทดสอบก่อน
 * ไฟล์นี้ยังไม่สร้าง Trigger อัตโนมัติ
 */

const WC_CONFIG = Object.freeze({
  BASE_URL: 'https://rocket75.com',
  SPREADSHEET_ID: '1ZAwFNUAlawqkaOtifElf5o7X9K8r47Id3b-7StQ8O2w',
  SHEET_NAME: 'warning_card',
  TIME_ZONE: 'Asia/Bangkok',
  START_DATE: '16/12/2025',
  USERNAME_PROPERTY: 'ROCKET_USERNAME',
  PASSWORD_PROPERTY: 'ROCKET_PASSWORD',
  TABLE_PATH: '/hr/ajax/warning_card/Table.php',
  REFERER_PATH: '/hr/warning_card.php'
});

const WC_HEADERS = Object.freeze([
  'รหัสรายการ',
  'วันที่ออก',
  'ผู้ออก',
  'เลขใบเตือน',
  'ประเภท',
  'เรื่อง',
  'ระดับการตักเตือน',
  'ผู้รับ',
  'รหัสพนักงาน',
  'สถานะ',
  'ลิงก์ PDF',
  'Data Update'
]);

/**
 * ฟังก์ชันหลัก: ดึงรายการตั้งแต่ 16/12/2025 ถึงวันนี้
 * หลังตรวจ Response สำเร็จแล้ว จะเขียน snapshot ล่าสุดลง A:L ของชีต warning_card
 */
function syncRocketWarningCard() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error('มี syncRocketWarningCard รอบอื่นกำลังทำงานอยู่ จึงยกเลิกรอบซ้อนนี้');
  }

  try {
    const credentials = wcGetCredentials_();
    const session = wcLogin_(credentials.username, credentials.password);
    const range = wcGetWarningRange_();
    const html = wcFetchWarningTable_(session, range.startDate, range.endDate);
    const rows = wcParseWarningRows_(html);
    wcValidateUniqueIds_(rows);
    wcWriteSnapshot_(rows, range);

    const summary = 'Warning Card sync สำเร็จ | ช่วง ' + range.startDate +
      ' - ' + range.endDate + ' | จำนวน ' + rows.length + ' รายการ';
    console.log(summary);
    return summary;
  } finally {
    lock.releaseLock();
  }
}

function wcGetCredentials_() {
  const properties = PropertiesService.getScriptProperties();
  const username = String(properties.getProperty(WC_CONFIG.USERNAME_PROPERTY) || '').trim();
  const password = String(properties.getProperty(WC_CONFIG.PASSWORD_PROPERTY) || '');

  if (!username || !password) {
    throw new Error(
      'ยังไม่ได้ตั้ง Script Properties: ' +
      WC_CONFIG.USERNAME_PROPERTY + ' และ ' + WC_CONFIG.PASSWORD_PROPERTY
    );
  }
  return { username: username, password: password };
}

function wcExtractPhpSession_(response) {
  const headers = response.getAllHeaders();
  let setCookie = headers['Set-Cookie'] || headers['set-cookie'];

  if (!setCookie) return '';
  if (Array.isArray(setCookie)) setCookie = setCookie.join('; ');

  const match = String(setCookie).match(/PHPSESSID=([^;]+)/i);
  return match ? 'PHPSESSID=' + match[1] : '';
}

/** Login หนึ่งครั้งต่อการรัน และเก็บ PHPSESSID (ถ้ามี) + token + key */
function wcLogin_(username, password) {
  const loginPage = WC_CONFIG.BASE_URL + '/index.php';
  const authUrl = WC_CONFIG.BASE_URL + '/auth.php';
  const firstResponse = UrlFetchApp.fetch(loginPage, {
    method: 'get',
    followRedirects: false,
    muteHttpExceptions: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GoogleAppsScript)' }
  });

  const firstHttp = firstResponse.getResponseCode();
  if (firstHttp < 200 || firstHttp >= 400) {
    throw new Error('เปิดหน้า Login ไม่สำเร็จ HTTP ' + firstHttp);
  }

  let cookie = wcExtractPhpSession_(firstResponse);
  const loginHeaders = {
    Origin: WC_CONFIG.BASE_URL,
    Referer: loginPage,
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': 'Mozilla/5.0 (compatible; GoogleAppsScript)'
  };
  if (cookie) loginHeaders.Cookie = cookie;

  const loginResponse = UrlFetchApp.fetch(authUrl, {
    method: 'post',
    payload: { username: username, password: password },
    headers: loginHeaders,
    followRedirects: false,
    muteHttpExceptions: true
  });

  const loginHttp = loginResponse.getResponseCode();
  if (loginHttp !== 200) throw new Error('Login HTTP ' + loginHttp);

  const newCookie = wcExtractPhpSession_(loginResponse);
  if (newCookie) cookie = newCookie;

  let data;
  try {
    data = JSON.parse(loginResponse.getContentText('UTF-8'));
  } catch (error) {
    throw new Error('auth.php ไม่ได้คืน JSON ที่ถูกต้อง');
  }

  const sing = Number(data && data.sing);
  if (sing === 0) throw new Error('Username หรือ Password ไม่ถูกต้อง');
  if (sing === 2) throw new Error('บัญชีต้องเปลี่ยน Password ก่อน');
  if (sing === 3) throw new Error('บัญชีถูกจำกัด กรุณาติดต่อผู้ดูแล');

  const token = String(data && data.token || '').trim();
  const key = String(data && data.key || '').trim();
  if (sing !== 1 || !token || !key) {
    throw new Error('Login ไม่สำเร็จ หรือไม่พบ token/key');
  }

  if (!cookie && data.PHPSESSID) cookie = 'PHPSESSID=' + data.PHPSESSID;
  return { cookie: cookie || '', token: token, key: key };
}

/** ใช้ช่วงคงที่ตั้งแต่ 16/12/2025 ถึงวันที่ปัจจุบัน */
function wcGetWarningRange_() {
  const today = Utilities.formatDate(new Date(), WC_CONFIG.TIME_ZONE, 'yyyy-MM-dd').split('-');
  const endYear = Number(today[0]);
  const month = Number(today[1]);
  const endDay = Number(today[2]);

  return {
    startDate: WC_CONFIG.START_DATE,
    endDate: wcPad2_(endDay) + '/' + wcPad2_(month) + '/' + endYear
  };
}

function wcPad2_(value) {
  return String(value).padStart(2, '0');
}

function wcFetchWarningTable_(session, startDate, endDate) {
  const requestHeaders = {
    Origin: WC_CONFIG.BASE_URL,
    Referer: WC_CONFIG.BASE_URL + WC_CONFIG.REFERER_PATH,
    Accept: 'text/html, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': 'Mozilla/5.0 (compatible; GoogleAppsScript)'
  };
  if (session.cookie) requestHeaders.Cookie = session.cookie;

  const response = UrlFetchApp.fetch(WC_CONFIG.BASE_URL + WC_CONFIG.TABLE_PATH, {
    method: 'post',
    payload: {
      active_status: '0',
      name_search: '',
      start_date: startDate,
      end_date: endDate,
      warning_type_id: '',
      status_type: '',
      user_type: '',
      filter_approve_status: '',
      token: session.token,
      key: session.key
    },
    headers: requestHeaders,
    followRedirects: false,
    muteHttpExceptions: true
  });

  const http = response.getResponseCode();
  if (http !== 200) throw new Error('โหลดรายงานใบเตือนไม่สำเร็จ HTTP ' + http);

  const html = response.getContentText('UTF-8');
  const hasExpectedTable = /<table\b[^>]*id=["']myTable["']/i.test(html);
  const isExplicitlyEmpty = /ไม่พบข้อมูล|ไม่มีข้อมูล/i.test(html);

  if (!hasExpectedTable && !isExplicitlyEmpty) {
    throw new Error(
      'Response ไม่ใช่ตารางใบเตือน อาจเป็นหน้า Login, Session หมดอายุ หรือโครงสร้างหน้าเว็บเปลี่ยน'
    );
  }
  return html;
}

function wcParseWarningRows_(html) {
  const tableMatch = String(html).match(
    /<table\b[^>]*id=["']myTable["'][^>]*>([\s\S]*?)<\/table>/i
  );
  if (!tableMatch) return [];

  const bodyMatch = tableMatch[1].match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!bodyMatch) throw new Error('พบตารางใบเตือน แต่ไม่พบ tbody');

  const rows = [];
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  const dataUpdate = new Date();

  while ((rowMatch = rowRegex.exec(bodyMatch[1])) !== null) {
    const cells = wcExtractCells_(rowMatch[1]);
    if (cells.length === 0) continue;
    if (cells.length < 8) throw new Error('โครงสร้างแถวใบเตือนไม่ครบ 8 คอลัมน์');

    const dateAndIssuer = wcExtractTagTexts_(cells[1], 'div');
    const warningNumber = wcFirstTagText_(cells[2], 'span');
    const warningType = wcFirstTagText_(cells[3], 'div');
    const subjectResult = wcExtractWarningLevel_(wcFirstTagText_(cells[4], 'div'));
    const subject = subjectResult.subject;
    const warningLevel = subjectResult.warningLevel;
    const recipient = wcExtractTagTexts_(cells[5], 'div');
    const status = wcFirstTagText_(cells[6], 'span');
    const actionHtml = cells[7];

    const idMatch = actionHtml.match(/[?&]id=(\d+)/i) ||
      actionHtml.match(/(?:ModalApprove|ModalCopySignLink|Delete)\(\s*["'](\d+)["']/i);
    const typeMatch = actionHtml.match(/[?&](?:amp;)?type=(\d+)/i);
    const rawId = idMatch ? idMatch[1] : '';
    const typeId = typeMatch ? typeMatch[1] : '';

    const dateText = dateAndIssuer[0] || '';
    const issuer = dateAndIssuer[1] || '';
    const recipientName = recipient[0] || '';
    const employeeCode = recipient[1] || '';

    if (!rawId) throw new Error('พบแถวที่ไม่มีรหัส id ดิบในคอลัมน์จัดการ');
    if (!dateText || !warningNumber) {
      throw new Error('รายการ id ' + rawId + ' ไม่มีวันที่ออกหรือเลขใบเตือน');
    }

    const pdfUrl = typeId
      ? WC_CONFIG.BASE_URL + '/print/print_warning_card.php?id=' + rawId + '&type=' + typeId
      : '';

    rows.push([
      rawId,
      wcParseThaiDate_(dateText),
      issuer,
      warningNumber,
      warningType,
      subject,
      warningLevel,
      recipientName,
      employeeCode,
      status,
      pdfUrl,
      dataUpdate
    ]);
  }

  return rows;
}

function wcExtractWarningLevel_(subjectText) {
  const subject = String(subjectText || '').trim();
  const match = subject.match(/(หนังสือตักเตือน.*?ครั้งที่\s*\d+)\s*$/i);
  if (!match) return { subject: subject, warningLevel: '' };

  return {
    subject: subject,
    warningLevel: match[1].trim()
  };
}

function wcExtractCells_(rowHtml) {
  const cells = [];
  const cellRegex = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  let match;
  while ((match = cellRegex.exec(rowHtml)) !== null) cells.push(match[1]);
  return cells;
}

function wcExtractTagTexts_(html, tagName) {
  const texts = [];
  const regex = new RegExp('<' + tagName + '\\b[^>]*>([\\s\\S]*?)<\\/' + tagName + '>', 'gi');
  let match;
  while ((match = regex.exec(html)) !== null) texts.push(wcHtmlToText_(match[1]));
  return texts;
}

function wcFirstTagText_(html, tagName) {
  const texts = wcExtractTagTexts_(html, tagName);
  return texts.length ? texts[0] : wcHtmlToText_(html);
}

function wcHtmlToText_(html) {
  return wcDecodeHtml_(
    String(html || '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

function wcDecodeHtml_(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, function(_, hex) {
      return String.fromCodePoint(parseInt(hex, 16));
    })
    .replace(/&#(\d+);/g, function(_, decimal) {
      return String.fromCodePoint(Number(decimal));
    });
}

function wcParseThaiDate_(text) {
  const value = String(text || '').trim();
  if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value)) {
    throw new Error('รูปแบบวันที่ใบเตือนไม่ถูกต้อง: ' + value);
  }

  try {
    return Utilities.parseDate(value, WC_CONFIG.TIME_ZONE, 'dd/MM/yyyy');
  } catch (error) {
    throw new Error('อ่านวันที่ใบเตือนไม่ได้: ' + value);
  }
}

function wcValidateUniqueIds_(rows) {
  const seen = Object.create(null);
  rows.forEach(function(row) {
    const id = String(row[0]);
    if (seen[id]) {
      throw new Error('พบรหัสรายการซ้ำใน Response: ' + id + ' จึงไม่เขียนลงชีต');
    }
    seen[id] = true;
  });
}

/** เขียนเฉพาะ A:L หลังจาก fetch/parse/validate สำเร็จแล้ว */
function wcWriteSnapshot_(rows, range) {
  const spreadsheet = SpreadsheetApp.openById(WC_CONFIG.SPREADSHEET_ID);
  if (spreadsheet.getSpreadsheetTimeZone() !== WC_CONFIG.TIME_ZONE) {
    spreadsheet.setSpreadsheetTimeZone(WC_CONFIG.TIME_ZONE);
  }

  let sheet = spreadsheet.getSheetByName(WC_CONFIG.SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(WC_CONFIG.SHEET_NAME);

  const columnCount = WC_HEADERS.length;
  const oldFilter = sheet.getFilter();
  if (oldFilter) oldFilter.remove();

  sheet.getRange(1, 1, 2, columnCount).breakApart();
  const rowsToClear = Math.max(sheet.getLastRow(), rows.length + 2, 2);
  sheet.getRange(1, 1, rowsToClear, columnCount).clearContent();

  const rangeText = 'ช่วงข้อมูล ' + range.startDate + ' - ' + range.endDate +
    ' | จำนวน ' + rows.length + ' รายการ';
  sheet.getRange(1, 1, 1, columnCount).merge().setValue(rangeText);
  sheet.getRange(2, 1, 1, columnCount).setValues([WC_HEADERS]);

  if (rows.length > 0) {
    sheet.getRange(3, 1, rows.length, columnCount).setValues(rows);
  }

  wcFormatSheet_(sheet, rows.length);
  SpreadsheetApp.flush();
}

function wcFormatSheet_(sheet, dataRowCount) {
  const columnCount = WC_HEADERS.length;
  sheet.getRange(1, 1, 1, columnCount)
    .setBackground('#fff2cc')
    .setFontWeight('bold')
    .setHorizontalAlignment('left')
    .setVerticalAlignment('middle');
  sheet.setRowHeight(1, 28);

  sheet.getRange(2, 1, 1, columnCount)
    .setBackground('#fff200')
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true);
  sheet.setFrozenRows(2);

  const widths = [120, 110, 210, 140, 190, 360, 230, 190, 110, 110, 300, 145];
  for (let i = 0; i < widths.length; i++) sheet.setColumnWidth(i + 1, widths[i]);

  if (dataRowCount > 0) {
    sheet.getRange(3, 1, dataRowCount, columnCount)
      .setVerticalAlignment('top')
      .setWrap(true);
    sheet.getRange(3, 1, dataRowCount, 1).setNumberFormat('@');
    sheet.getRange(3, 2, dataRowCount, 1).setNumberFormat('dd/MM/yyyy');
    sheet.getRange(3, 4, dataRowCount, 1).setNumberFormat('@');
    sheet.getRange(3, 9, dataRowCount, 1).setNumberFormat('@');
    sheet.getRange(3, 12, dataRowCount, 1).setNumberFormat('dd/MM/yyyy HH:mm:ss');
  }

  sheet.getRange(2, 1, Math.max(2, dataRowCount + 1), columnCount).createFilter();
}
