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
  REFERER_PATH: '/hr/warning_card.php',
  // ผู้รับเหล่านี้ไม่เอาใบที่ออกก่อนวันที่กำหนด (เทียบชื่อจริง ไม่รวมคำนำหน้า)
  RECIPIENT_START_DATES: Object.freeze({
    'ปรัชญา': '16/03/2026',
    'นฤมล': '16/03/2026',
    'หยกเพชร': '16/03/2026'
  })
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
    const rows = wcExcludeEarlyRecipients_(wcParseWarningRows_(html));
    wcValidateUniqueIds_(rows);
    wcFillLevelsFromPrint_(rows, session);
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
    const rawCells = wcExtractCells_(rowMatch[1]);
    if (rawCells.length === 0) continue;
    if (rawCells.length < 8) {
      throw new Error('โครงสร้างแถวใบเตือนไม่ครบ 8 คอลัมน์ | ' + wcDescribeCells_(rawCells));
    }
    // บางแถวมี <td> เกินมาตรงกลาง (หลังเลขใบเตือน) จึงยึด 3 คอลัมน์แรกจากหน้า
    // และ 5 คอลัมน์สุดท้าย (ประเภท, เรื่อง, ผู้รับ, สถานะ, จัดการ) จากท้ายแถว
    const cells = rawCells.length === 8
      ? rawCells
      : rawCells.slice(0, 3).concat(rawCells.slice(-5));

    const dateAndIssuer = wcExtractTagTexts_(cells[1], 'div');
    const warningNumber = wcFirstTagText_(cells[2], 'span');
    const warningType = wcFirstTagText_(cells[3], 'div');
    const subjectResult = wcExtractWarningLevel_(wcFirstTagText_(cells[4], 'div'));
    const subject = subjectResult.subject;
    const warningLevel = subjectResult.warningLevel;
    const recipient = wcExtractTagTexts_(cells[5], 'div');
    const status = wcFirstTagText_(cells[6], 'span');
    const actionHtml = cells[7];

    const rawId = wcExtractRawId_(actionHtml);
    const typeMatch = actionHtml.match(/[?&](?:amp;)?type=(\d+)/i);
    const typeId = typeMatch ? typeMatch[1] : '';

    const dateText = dateAndIssuer[0] || '';
    const issuer = dateAndIssuer[1] || '';
    const recipientName = recipient[0] || '';
    const employeeCode = recipient[1] || '';

    if (!rawId) {
      throw new Error(
        'พบแถวที่ไม่มีรหัส id ดิบในคอลัมน์จัดการ | เลขใบเตือน ' + (warningNumber || '-') +
        ' | ' + wcDescribeCells_(rawCells) +
        ' | HTML จัดการ: ' + String(actionHtml).replace(/\s+/g, ' ').trim().slice(0, 300)
      );
    }
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

/** ตัดใบเตือนของผู้รับใน RECIPIENT_START_DATES ที่วันที่ออกก่อนวันที่กำหนด */
function wcExcludeEarlyRecipients_(rows) {
  const cutoffs = Object.create(null);
  Object.keys(WC_CONFIG.RECIPIENT_START_DATES).forEach(function(name) {
    cutoffs[name] = wcParseThaiDate_(WC_CONFIG.RECIPIENT_START_DATES[name]).getTime();
  });

  const kept = rows.filter(function(row) {
    const firstName = String(row[7] || '').trim()
      .replace(/^(นางสาว|นาง|นาย|น\.ส\.)\s*/, '')
      .split(/\s+/)[0];
    const cutoff = cutoffs[firstName];
    return cutoff === undefined || row[1].getTime() >= cutoff;
  });

  if (kept.length !== rows.length) {
    console.log('ตัดใบเตือนก่อนวันเริ่มของผู้รับที่กำหนด: ' + (rows.length - kept.length) + ' รายการ');
  }
  return kept;
}

/**
 * แถวที่ "เรื่อง" ไม่บอกระดับการตักเตือน ให้เปิดหน้าพิมพ์ใบเตือน (คอลัมน์ลิงก์ PDF)
 * แล้วอ่านหัวเอกสาร เช่น "หนังสือเตือนภายใน"
 * - ใช้ค่าที่เคยอ่านได้ในชีตเดิมก่อน (ระดับของใบที่ออกแล้วไม่เปลี่ยน) จะได้ไม่โหลดซ้ำทุกรอบ
 * - ถ้าอ่านไม่ได้จะปล่อยว่างและ log ไว้ ไม่ทำให้ sync ทั้งรอบล้ม
 */
function wcFillLevelsFromPrint_(rows, session) {
  const ID_COL = 0;
  const LEVEL_COL = 6;
  const PDF_COL = 10;

  const missing = rows.filter(function(row) { return !row[LEVEL_COL] && row[PDF_COL]; });
  if (missing.length === 0) return;

  const cached = wcReadExistingLevels_();
  const toFetch = [];
  missing.forEach(function(row) {
    const known = cached[String(row[ID_COL])];
    if (known) row[LEVEL_COL] = known;
    else toFetch.push(row);
  });

  const headers = {
    Referer: WC_CONFIG.BASE_URL + WC_CONFIG.REFERER_PATH,
    'User-Agent': 'Mozilla/5.0 (compatible; GoogleAppsScript)'
  };
  if (session.cookie) headers.Cookie = session.cookie;

  // โหลด + OCR ทีละใบ (rocket75 ไม่รับ fetchAll แบบขนาน -> "Address unavailable")
  // และจำกัดเวลารวม ใบที่เหลือจะไปทำต่อรอบหน้า เพราะใบที่อ่านได้แล้วถูกเก็บในชีต
  const TIME_BUDGET_MS = 3 * 60 * 1000;
  const startedAt = Date.now();
  let filled = 0;
  let skipped = 0;
  const failed = [];
  for (let i = 0; i < toFetch.length; i++) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      skipped = toFetch.length - i;
      break;
    }
    const row = toFetch[i];
    let reason;
    try {
      const response = UrlFetchApp.fetch(row[PDF_COL], {
        method: 'get',
        headers: headers,
        followRedirects: false,
        muteHttpExceptions: true
      });
      reason = wcReadLevelFromPrint_(response, row);
    } catch (error) {
      reason = error.message;
    }
    if (reason) failed.push(row[3] + ' (' + reason + ')');
    else filled++;
  }

  console.log(
    'ระดับการตักเตือนจากหน้าพิมพ์: ใช้ค่าเดิม ' + (missing.length - toFetch.length) +
    ' | อ่านใหม่ได้ ' + filled + ' | อ่านไม่ได้ ' + failed.length +
    (skipped ? ' | เหลือไว้รอบหน้า ' + skipped : '')
  );
  if (failed.length) console.warn('อ่านระดับจากหน้าพิมพ์ไม่ได้: ' + failed.slice(0, 20).join(', '));
}

/** คืนข้อความเหตุผลถ้าอ่านไม่ได้, คืน '' ถ้าเติมระดับลง row สำเร็จ */
function wcReadLevelFromPrint_(response, row) {
  const http = response.getResponseCode();
  if (http !== 200) return 'HTTP ' + http;

  const contentType = String(response.getHeaders()['Content-Type'] ||
    response.getHeaders()['content-type'] || '');
  const bytes = response.getContent();
  const isPdf = /pdf/i.test(contentType) ||
    (bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);

  // หน้าพิมพ์ของ rocket75 เป็น PDF (FPDF) ที่ฟอนต์ไทยไม่มี ToUnicode
  // จึงต้องให้ Google Drive OCR เป็นข้อความก่อน
  // เก็บการขึ้นบรรทัดไว้ เพราะหัวเอกสารหาจากบรรทัด
  const text = isPdf
    ? wcOcrPdfText_(response.getBlob().setName('warning_' + row[0] + '.pdf'))
    : String(response.getContentText('UTF-8'))
      .replace(/<head\b[\s\S]*?<\/head>/gi, ' ')
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
      .split(/<br\s*\/?>|<\/(?:p|div|h\d|tr|li|center)>/i)
      .map(wcHtmlToText_)
      .join('\n');

  const level = wcExtractLevelFromPrintText_(text) || wcExtractDocumentTitle_(text);
  if (!level) {
    return 'ไม่พบหัวเอกสาร | ข้อความต้นเอกสาร: ' +
      String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  row[6] = level;
  return '';
}

/**
 * OCR PDF ด้วย Advanced Drive Service: อัปโหลดเป็น Google Doc ชั่วคราว อ่านข้อความ แล้วลบทิ้ง
 * ต้องเปิด "บริการ" > Drive API ในโปรเจกต์ Apps Script ก่อน
 */
function wcOcrPdfText_(blob) {
  if (typeof Drive === 'undefined') {
    throw new Error('ยังไม่ได้เปิด Advanced Service "Drive API" ในโปรเจกต์ Apps Script');
  }
  let fileId;
  try {
    if (typeof Drive.Files.create === 'function') {
      fileId = Drive.Files.create(
        { name: blob.getName(), mimeType: 'application/vnd.google-apps.document' },
        blob,
        { ocrLanguage: 'th' }
      ).id;
    } else {
      fileId = Drive.Files.insert(
        { title: blob.getName(), mimeType: 'application/vnd.google-apps.document' },
        blob,
        { ocr: true, ocrLanguage: 'th' }
      ).id;
    }
    return DocumentApp.openById(fileId).getBody().getText();
  } finally {
    if (fileId) {
      try {
        Drive.Files.remove(fileId);
      } catch (error) {
        try { DriveApp.getFileById(fileId).setTrashed(true); } catch (ignored) {}
      }
    }
  }
}

/**
 * หาระดับการตักเตือนจากข้อความในใบเตือน
 * 1) ประโยคในเนื้อความ เช่น "ออก หนังสือเตือนภายใน ครั้งที่ 1" (มีครั้งที่)
 * 2) หัวเอกสาร เช่น "หนังสือเตือนภายใน"
 * OCR ภาษาไทยมักแทรกช่องว่างกลางคำ จึงยอมให้มีช่องว่างได้
 */
function wcExtractLevelFromPrintText_(rawText) {
  const text = String(rawText || '').replace(/[​ ]/g, ' ');
  const KNOWN = '(ภายใน|ด้วยวาจา|เป็นลายลักษณ์อักษร|ครั้งสุดท้าย)';
  const sp = '\\s*';
  const head = 'หนังสือ' + sp + '(?:ตัก' + sp + ')?เตือน' + sp;
  const toPlain = function(s) { return String(s).replace(/\s+/g, ''); };

  const withTimes = text.match(new RegExp(head + wcSpacedWord_(KNOWN) + sp + 'ครั้ง' + sp + 'ที่' + sp + '(\\d+)'));
  if (withTimes) return 'หนังสือตักเตือน' + toPlain(withTimes[1]) + ' ครั้งที่ ' + withTimes[2];

  const known = text.match(new RegExp(head + wcSpacedWord_(KNOWN)));
  if (known) return 'หนังสือตักเตือน' + toPlain(known[1]);

  const other = text.match(/หนังสือ(?:ตัก)?เตือน([ก-๙]+)/);
  return other ? 'หนังสือตักเตือน' + other[1] : '';
}

/**
 * เอกสารที่ไม่ใช่หนังสือเตือน (เช่น "บันทึกความเสียหาย") ใช้หัวเอกสารแทนระดับ
 * หัวเอกสารคือบรรทัดภาษาไทยบรรทัดแรกที่ไม่ใช่ เลขที่/หน้า/วันที่/เรื่อง/เรียน
 * OCR มักแทรกช่องว่างระหว่างตัวอักษรไทย จึงลบช่องว่างที่อยู่ระหว่างอักษรไทยออก
 */
function wcExtractDocumentTitle_(rawText) {
  const SKIP = /^(เลขที่|หน้า|วันที่|เรื่อง|เรียน|อ้างถึง|สิ่งที่ส่งมาด้วย)/;
  const lines = String(rawText || '').replace(/[​ ]/g, ' ').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+/g, ' ').trim()
      .replace(/([ก-๙])\s+(?=[ก-๙])/g, '$1');
    if (!/[ก-๙]/.test(line) || line.length > 60) continue;
    if (SKIP.test(line.replace(/\s+/g, ''))) continue;
    return line;
  }
  return '';
}

/** แปลง (คำ1|คำ2) เป็น regex ที่ยอมให้มีช่องว่างระหว่างตัวอักษร */
function wcSpacedWord_(group) {
  const words = group.replace(/^\(|\)$/g, '').split('|');
  return '(' + words.map(function(w) { return w.split('').join('\\s*'); }).join('|') + ')';
}

/** อ่าน id -> ระดับการตักเตือน จากชีตเดิม (ข้ามแถวที่ว่าง) */
function wcReadExistingLevels_() {
  const map = Object.create(null);
  try {
    const sheet = SpreadsheetApp.openById(WC_CONFIG.SPREADSHEET_ID).getSheetByName(WC_CONFIG.SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 3) return map;
    const values = sheet.getRange(3, 1, sheet.getLastRow() - 2, 7).getValues();
    values.forEach(function(v) {
      const id = String(v[0]).trim();
      const level = String(v[6]).trim();
      if (id && level) map[id] = level;
    });
  } catch (error) {
    console.warn('อ่านระดับเดิมจากชีตไม่ได้: ' + error.message);
  }
  return map;
}

/** สรุปจำนวน <td> และข้อความสั้นๆ ของแต่ละช่อง ไว้ใช้ใน error message */
function wcDescribeCells_(cells) {
  return 'พบ ' + cells.length + ' ช่อง: ' + cells.map(function(cell, i) {
    return '[' + i + '] ' + wcHtmlToText_(cell).slice(0, 40);
  }).join(' / ');
}

/** หา id ดิบจากคอลัมน์จัดการ: ลิงก์ ?id=, data-id, หรือฟังก์ชัน onclick ที่รับเลขตัวแรก */
function wcExtractRawId_(actionHtml) {
  const html = String(actionHtml || '');
  const match = html.match(/[?&](?:amp;)?id=(\d+)/i) ||
    html.match(/\bdata-(?:id|warning-id|warning_card_id)\s*=\s*["']?(\d+)/i) ||
    html.match(/\b[A-Za-z_$][\w$]*\(\s*["']?(\d+)["']?\s*[,)]/);
  return match ? match[1] : '';
}

function wcExtractWarningLevel_(subjectText) {
  const subject = String(subjectText || '').trim();
  // rocket75 ใช้ทั้ง "หนังสือตักเตือน..." และ "หนังสือเตือน..." จึงรับทั้งสองแบบ
  // แล้วปรับเป็น "หนังสือตักเตือน" ให้กรองในชีตได้ง่าย
  const match = subject.match(/หนังสือ(?:ตัก)?เตือน(.*?ครั้งที่\s*\d+)\s*$/i);
  if (!match) return { subject: subject, warningLevel: '' };

  return {
    subject: subject,
    warningLevel: ('หนังสือตักเตือน' + match[1]).replace(/\s+/g, ' ').trim()
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
  const rangeText = 'ช่วงข้อมูล ' + range.startDate + ' - ' + range.endDate +
    ' | จำนวน ' + rows.length + ' รายการ';
  const snapshot = [[rangeText].concat(Array(columnCount - 1).fill('')), WC_HEADERS].concat(rows);
  const requiredRows = Math.max(sheet.getLastRow(), snapshot.length);
  while (snapshot.length < requiredRows) snapshot.push(Array(columnCount).fill(''));
  if (sheet.getMaxRows() < requiredRows) {
    sheet.insertRowsAfter(sheet.getMaxRows(), requiredRows - sheet.getMaxRows());
  }
  sheet.getRange(1, 1, 2, columnCount).breakApart();
  // Replace values and the obsolete tail together; never clear the last snapshot first.
  sheet.getRange(1, 1, snapshot.length, columnCount).setValues(snapshot);

  const oldFilter = sheet.getFilter();
  if (oldFilter) oldFilter.remove();
  sheet.getRange(1, 1, 1, columnCount).merge();

  wcFormatSheet_(sheet, rows.length);
  SpreadsheetApp.flush();
  console.log('เขียนลงไฟล์: ' + spreadsheet.getName() + ' | ชีต: ' + sheet.getName() +
    ' | ' + spreadsheet.getUrl() + '#gid=' + sheet.getSheetId());
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
