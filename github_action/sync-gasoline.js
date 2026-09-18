/*************************************************
 * SYNC GASOLINE DETAIL — Node.js port ของ
 * syncGasolineTeamTest() ใน gasoline.js (Apps Script)
 *
 * Logic เดียวกันทุกจุด แค่เปลี่ยนเครื่องมือ:
 *   UrlFetchApp        -> fetch (Node 18+ built-in)
 *   Utilities.unzip +
 *   regex XML parser   -> library "xlsx" (SheetJS)
 *   SpreadsheetApp     -> Google Sheets API (googleapis)
 *
 * ต้องมี environment variables (ตั้งเป็น GitHub Actions
 * secrets):
 *   ROCKET_USERNAME, ROCKET_PASSWORD  — login rocket75.com
 *   GOOGLE_SERVICE_ACCOUNT_KEY        — JSON key ทั้งก้อน
 *     ของ service account (ต้องแชร์ Google Sheet ให้
 *     อีเมลของ service account เป็น Editor ก่อน)
 *   SPREADSHEET_ID                    — ID ของชีท (จาก
 *     URL: .../spreadsheets/d/<ID>/edit)
 *
 * ทดสอบผ่านแล้วบนชีท "Gasoline Detail (Test)" — Apps
 * Script trigger เดิมปิดไปแล้ว จึงสลับมาเขียนชีท
 * "Gasoline Detail" จริง
 *************************************************/

const { google } = require('googleapis');
const XLSX = require('xlsx');
const rocket = require('./lib/rocket-client');

const ROCKET_BASE = rocket.ROCKET_BASE;
const TICKETS_SHEET_NAME = 'Tickets';
const GASOLINE_SHEET_NAME = 'Gasoline Detail';
const RATE_PER_JOB = 80;

// ช่วงวันที่เริ่มต้น: ดึงตั้งแต่วันที่ 1 ของเดือนที่แล้วเสมอ (01/MM/YYYY) ถึงวันนี้ (ตามเวลากรุงเทพ)
// เพื่อให้ข้อมูล 1 เดือนล่าสุดและเดือนปัจจุบันถูกดึงมาอัปเดตสถานะและ Timestamp ในชีททุกรอบ (Sync Gasoline Detail)
// รองรับ override ผ่าน environment variables (GASOLINE_START_DATE, GASOLINE_END_DATE) สำหรับยิงย้อนหลัง
function computeDateRange(startOverride, endOverride, baseDate = new Date()) {

  function bangkokDateParts(date) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const get = function(t) { return Number(parts.find(function(p) { return p.type === t; }).value); };
    return { year: get('year'), month: get('month'), day: get('day') };
  }

  function fmt(year, month, day) {
    const dd = String(day).padStart(2, '0');
    const mm = String(month).padStart(2, '0');
    return dd + '/' + mm + '/' + year;
  }

  const now = bangkokDateParts(baseDate);

  let start = (startOverride || '').trim();
  let end = (endOverride || '').trim();

  // ถ้าไม่ระบุ start_date -> ใช้วันที่ 1 ของเดือนที่แล้วเสมอ (1 เดือนล่าสุด: ตามเวลากรุงเทพ)
  if (!start) {
    let startYear = now.year;
    let startMonth = now.month - 1;
    while (startMonth < 1) {
      startMonth += 12;
      startYear -= 1;
    }
    start = fmt(startYear, startMonth, 1);
  }

  // ถ้าไม่ระบุ end_date -> ใช้วันนี้ (ตามเวลากรุงเทพ)
  if (!end) {
    end = fmt(now.year, now.month, now.day);
  }

  return { start: start, end: end };

}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// 4 ทีมเดียวกับที่ยืนยันแล้วบน Apps Script
const GASOLINE_TEAM_IDS = [
  { id: '8002371330', label: 'A (BK)' },
  { id: '6371395077', label: 'B (BK)' },
  { id: '3696295156', label: 'Training' },
  { id: '9751260652', label: 'หัวหน้าช่าง' }
];

const GASOLINE_DETAIL_HEADERS = [
  'Date Arrived',
  'Job No.',
  'Ticket No. (BK)',
  'Customer Name',
  'Technician Name',
  'All Technicians',
  'Team',
  'Counted',
  'Remarks',
  'Last Sync',
  'URL',
  'Review',
  'Note',
  'Count Stack',
  'Amount Received'
];



/*************************************************
 * LOGIN (เหมือน poc-login.js)
 *************************************************/

async function rocketLogin() {

  const username = process.env.ROCKET_USERNAME;
  const password = process.env.ROCKET_PASSWORD;

  if (!username || !password) {
    throw new Error('ไม่พบ ROCKET_USERNAME / ROCKET_PASSWORD ใน environment variables');
  }

  const firstRes = await fetch(ROCKET_BASE + '/index.php', {
    method: 'GET',
    redirect: 'manual'
  });

  let cookie = '';
  const firstSetCookie = firstRes.headers.get('set-cookie');
  const firstMatch = firstSetCookie && firstSetCookie.match(/PHPSESSID=([^;]+)/i);
  if (firstMatch) {
    cookie = 'PHPSESSID=' + firstMatch[1];
  }

  const loginBody = new URLSearchParams();
  loginBody.set('username', username);
  loginBody.set('password', password);

  const loginHeaders = {
    Origin: ROCKET_BASE,
    Referer: ROCKET_BASE + '/index.php',
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest'
  };
  if (cookie) {
    loginHeaders.Cookie = cookie;
  }

  const loginRes = await fetch(ROCKET_BASE + '/auth.php', {
    method: 'POST',
    headers: loginHeaders,
    body: loginBody,
    redirect: 'manual'
  });

  const loginText = await loginRes.text();

  let data;
  try {
    data = JSON.parse(loginText);
  } catch (e) {
    throw new Error('auth.php ไม่คืน JSON: ' + loginText.substring(0, 300));
  }

  if (Number(data.sing) !== 1 || !data.token || !data.key) {
    throw new Error('Login ไม่สำเร็จ (sing=' + data.sing + ')');
  }

  const newSetCookie = loginRes.headers.get('set-cookie');
  const newMatch = newSetCookie && newSetCookie.match(/PHPSESSID=([^;]+)/i);
  if (newMatch) {
    cookie = 'PHPSESSID=' + newMatch[1];
  }

  return {
    cookie: cookie,
    token: data.token,
    key: data.key
  };

}



/*************************************************
 * FETCH + PARSE GASOLINE TEAM EXPORT
 * (แทนที่ buildGasolineTeamExportRequest_ +
 * extractGasolineTeamRows_ ใน gasoline.js)
 *************************************************/

async function fetchGasolineTeamXlsx(auth, teamId, range) {

  const body = new URLSearchParams();
  body.set('start_date', range.start);
  body.set('end_date', range.end);
  body.set('search_team', String(teamId));
  body.set('search_staff', 'x');
  body.set('token', auth.token);
  body.set('key', auth.key);

  const headers = {
    Origin: ROCKET_BASE,
    Referer: ROCKET_BASE + '/main/report_gasoline_cost.php',
    'X-Requested-With': 'XMLHttpRequest'
  };
  if (auth.cookie) {
    headers.Cookie = auth.cookie;
  }

  const res = await rocket.fetchWithTimeout(
    ROCKET_BASE + '/main/ajax/report_ticket/gasoline/export_cost_team.php',
    { method: 'POST', headers: headers, body: body },
    120000
  );

  if (res.status !== 200) {
    throw new Error('Gasoline team export HTTP ' + res.status);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);

}



function extractGasolineTeamRows(xlsxBuffer) {

  const workbook = XLSX.read(xlsxBuffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];

  // header: 1 = คืนเป็น array ของ array (แถวดิบ, 0-indexed
  // ตามคอลัมน์จริง A=0,B=1,...) เหมือนที่ parseSheetRows_
  // ทำเองใน Apps Script แต่ library จัดการ shared string/
  // inline string/merge ให้หมดแล้ว ไม่ต้องเขียน parser เอง
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: ''
  });

  const headerRowIndex = rows.findIndex(function(row) {
    return row[0] === 'วันที่ถึงหน้างาน';
  });

  if (headerRowIndex === -1) {
    throw new Error('ไม่เจอแถว header ("วันที่ถึงหน้างาน") ในรายงานนี้ — โครงสร้างอาจเปลี่ยนไป');
  }

  // บันทึกช่วงวันที่ที่ระบุในไฟล์ Excel ของ Rocket75 (แถว 2 ก่อนหน้าหัวตาราง)
  if (headerRowIndex >= 2 && rows[headerRowIndex - 2] && rows[headerRowIndex - 2][0]) {
    console.log('ช่วงวันที่ในรายงานจาก Rocket: ' + String(rows[headerRowIndex - 2][0]).trim());
  }

  const teamNameRow = rows[headerRowIndex - 1];
  const teamName = (teamNameRow && teamNameRow[0]) ? String(teamNameRow[0]).trim() : '';

  const result = [];

  for (let i = headerRowIndex + 1; i < rows.length; i++) {

    const row = rows[i];
    const ticketNo = row[2];

    if (!ticketNo) {
      continue;
    }

    const countedRaw = row[5];
    const counted = Number(String(countedRaw || '0').replace(/,/g, '')) || 0;

    result.push({
      arrivedDate: row[0] || '',
      jobNo: row[1] || '',
      ticketNo: String(ticketNo),
      customer: row[3] || '',
      technician: row[4] || '',
      team: teamName,
      counted: counted,
      remarks: row[6] || ''
    });

  }

  return result;

}



/*************************************************
 * GOOGLE SHEETS HELPERS
 *************************************************/

async function getSheetsClient() {

  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) {
    throw new Error('ไม่พบ GOOGLE_SERVICE_ACCOUNT_KEY ใน environment variables');
  }

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(keyJson),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });

}



// แทนที่ getTicketNoToUrlMap_ ใน gasoline.js — join
// URL จากชีท Tickets ด้วย Ticket No (หา column โดย
// อ่านชื่อ header จริง ไม่ hardcode ตำแหน่งคอลัมน์)
async function getTicketNoToUrlMap(sheets, spreadsheetId) {

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId,
    range: "'" + TICKETS_SHEET_NAME + "'!A1:AJ"
  });

  const values = res.data.values || [];
  if (values.length < 2) {
    return {};
  }

  let headers = values[0];
  let dataStartIndex = 1;
  if (headers && headers[0] && String(headers[0]).startsWith('ช่วงข้อมูล')) {
    headers = values[1] || [];
    dataStartIndex = 2;
  }

  const ticketNoCol = headers.indexOf('Ticket No');
  const parentTicketNoCol = headers.indexOf('Parent Ticket No');
  const urlCol = headers.indexOf('URL');

  const map = {};

  for (let i = dataStartIndex; i < values.length; i++) {
    const row = values[i];
    const ticketNo = row[ticketNoCol];
    const url = (row[urlCol] || '').trim();
    if (ticketNo && url) {
      map[String(ticketNo).trim()] = url;
    }
    if (parentTicketNoCol !== -1 && row[parentTicketNoCol] && url) {
      const parentNo = String(row[parentTicketNoCol]).trim();
      if (!map[parentNo]) {
        map[parentNo] = url;
      }
    }
  }

  return map;

}



// อ่านรายชื่อช่างทั้งหมดจากชีท Trick2 (คอลัมน์ Job No -> Technician Name)
// ซึ่ง sync-trick2.js ดึงช่างทุกคนจากตาราง "ตรวจเช็ค/เข้าซ่อม" รวมไว้แล้ว
async function getTrick2TechniciansMap(sheets, spreadsheetId) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: "'Trick2'!C2:E"
    });
    const rows = res.data.values || [];
    const map = {};
    for (const row of rows) {
      const ticketNo = String(row[0] || '').trim();
      const allTechs = String(row[2] || '').trim();
      if (ticketNo && allTechs && ticketNo !== 'Job No. (BK)' && !ticketNo.startsWith('ช่วงข้อมูล')) {
        map[ticketNo] = allTechs;
        const parentNo = ticketNo.replace(/\.[A-Z0-9]+$/i, '').trim();
        if (parentNo && !map[parentNo]) {
          map[parentNo] = allTechs;
        }
      }
    }
    return map;
  } catch (err) {
    console.log('ไม่สามารถอ่านชีท Trick2 ได้ (จะ fallback ไปดึงจาก Rocket): ' + err.message);
    return {};
  }
}



function countStackFormula(rowNum) {
  return (
    '=IF(AND(H' + rowNum + '>0,L' + rowNum + '="Approved"),' +
    'COUNTIFS(' +
    '$E$3:E' + rowNum + ',E' + rowNum + ',' +
    '$H$3:H' + rowNum + ',">0",' +
    '$L$3:L' + rowNum + ',"Approved"),"")'
  );
}



function amountFormula(rowNum) {
  return '=IF(N' + rowNum + '="","",N' + rowNum + '*' + RATE_PER_JOB + ')';
}



// แทนที่ buildGasolineDetailRowIndex_ ใน gasoline.js
async function buildRowIndex(sheets, spreadsheetId, sheetName, sheetId, range, totalItems) {

  // ตรวจสอบว่าแถว 1 ปัจจุบันเป็น Header เดิม ("Date Arrived") หรือไม่
  // ถ้าใช่ ให้แทรก 1 แถวไว้บนสุด เพื่อให้แถว 1 เป็นช่วงข้อมูล และ Header เลื่อนไปแถว 2
  try {
    const a1Check = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: "'" + sheetName + "'!A1"
    });
    const a1Val = (a1Check.data.values && a1Check.data.values[0] && a1Check.data.values[0][0]) || '';
    if (a1Val === 'Date Arrived') {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: spreadsheetId,
        requestBody: {
          requests: [{
            insertDimension: {
              range: {
                sheetId: sheetId,
                dimension: 'ROWS',
                startIndex: 0,
                endIndex: 1
              },
              inheritFromBefore: false
            }
          }]
        }
      });
    }
  } catch (e) {
    console.log('ตรวจแถว 1:', e.message);
  }

  const rangeText = 'ช่วงข้อมูล ' + range.start + ' - ' + range.end +
    ' | จำนวน ' + (totalItems || 0).toLocaleString('en-US') + ' รายการ';

  // เขียนแถว 1 (ช่วงข้อมูล) และแถว 2 (หัวตาราง)
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        {
          range: "'" + sheetName + "'!A1",
          values: [[rangeText]]
        },
        {
          range: "'" + sheetName + "'!A2:O2",
          values: [GASOLINE_DETAIL_HEADERS]
        }
      ]
    }
  });

  // จัด Format แถว 1 (Merge, สีพื้นหลัง #fff2cc, ตัวหนา, Freeze 2 แถวแรก)
  if (sheetId !== null && sheetId !== undefined) {
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: spreadsheetId,
        requestBody: {
          requests: [
            {
              mergeCells: {
                range: {
                  sheetId: sheetId,
                  startRowIndex: 0,
                  endRowIndex: 1,
                  startColumnIndex: 0,
                  endColumnIndex: GASOLINE_DETAIL_HEADERS.length
                },
                mergeType: 'MERGE_ALL'
              }
            },
            {
              repeatCell: {
                range: {
                  sheetId: sheetId,
                  startRowIndex: 0,
                  endRowIndex: 1,
                  startColumnIndex: 0,
                  endColumnIndex: GASOLINE_DETAIL_HEADERS.length
                },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: { red: 1.0, green: 0.949, blue: 0.8 }, // #fff2cc
                    textFormat: { bold: true },
                    horizontalAlignment: 'LEFT',
                    verticalAlignment: 'MIDDLE'
                  }
                },
                fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)'
              }
            },
            {
              updateSheetProperties: {
                properties: {
                  sheetId: sheetId,
                  gridProperties: {
                    frozenRowCount: 2
                  }
                },
                fields: 'gridProperties.frozenRowCount'
              }
            }
          ]
        }
      });
    } catch (e) {
      console.log('จัด Format แถว 1/Freeze:', e.message);
    }
  }

  // อ่านข้อมูลเริ่มจากแถว 3 (ข้อมูลจริง) เพื่อเก็บ Review, Note, All Technicians, URL เดิม
  const valuesRes = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId,
    range: "'" + sheetName + "'!A3:M"
  });

  const ticketRows = valuesRes.data.values || [];

  // ตรวจจับ URL ที่ซ้ำข้าม Parent Ticket คนละเลข (เกิดจากบั๊กที่เคย fallback ด้วย "ใบงานเปล่า")
  // ซับทิกเก็ตใน Rocket จะมี ID เฉพาะตัว และต้องอยู่ใต้ Parent Ticket เดียวกันเสมอ
  const urlToParentMap = {};
  const crossParentDuplicateUrls = new Set();

  ticketRows.forEach(function(row) {
    const ticketNo = String(row[2] || '').trim();
    const existingUrl = String(row[10] || '').trim();
    if (ticketNo && existingUrl) {
      const parentNo = ticketNo.replace(/\.[A-Z0-9]+$/i, '').trim();
      if (!urlToParentMap[existingUrl]) {
        urlToParentMap[existingUrl] = parentNo;
      } else if (urlToParentMap[existingUrl] !== parentNo) {
        crossParentDuplicateUrls.add(existingUrl);
      }
    }
  });

  if (crossParentDuplicateUrls.size > 0) {
    console.log('พบ URL ที่ซ้ำข้ามตั๋วคนละใบ ' + crossParentDuplicateUrls.size + ' รายการ — จะล้าง URL ที่ผิดเพื่อดึงใหม่จาก Rocket');
  }

  const index = {};
  const existingReviews = {};
  const existingNotes = {};
  const existingAllTechs = {};
  const existingUrls = {};

  ticketRows.forEach(function(row, i) {
    const ticketNo = String(row[2] || '').trim();
    const techName = String(row[4] || '').trim(); // Col E: Technician Name
    const allTechs = String(row[5] || '').trim();
    const existingUrl = String(row[10] || '').trim();
    const review = String(row[11] || '').trim();
    const note = String(row[12] || '').trim();
    const rowNum = i + 3;

    if (ticketNo) {
      // ใช้ composite key (Ticket No + Technician Name) เพื่อรองรับกรณี 1 ตั๋วมีช่างหลายคนเคลมค่าน้ำมัน
      const compositeKey = ticketNo + '__' + techName;
      index[compositeKey] = rowNum;
      if (!index[ticketNo]) {
        index[ticketNo] = rowNum;
      }

      if (review) {
        existingReviews[compositeKey] = review;
        if (!existingReviews[ticketNo]) existingReviews[ticketNo] = review;
      }

      if (note) {
        existingNotes[compositeKey] = note;
        if (!existingNotes[ticketNo]) existingNotes[ticketNo] = note;
      }

      if (allTechs) {
        existingAllTechs[ticketNo] = allTechs;
      }

      if (existingUrl) {
        const parentNo = ticketNo.replace(/\.[A-Z0-9]+$/i, '').trim();
        // ถ้า URL นี้ซ้ำข้าม Parent Ticket และไม่ใช่ Parent Ticket แรกที่ตรงกับ URL ให้ถือว่าเพี้ยนและไม่เก็บ
        if (crossParentDuplicateUrls.has(existingUrl) && urlToParentMap[existingUrl] !== parentNo) {
          console.log('ตรวจพบ URL เพี้ยนในแถว ' + rowNum + ' (' + ticketNo + ') -> ล้าง URL เพื่อดึงใหม่');
        } else {
          existingUrls[ticketNo] = existingUrl;
        }
      }
    }
  });

  return {
    index: index,
    existingReviews: existingReviews,
    existingNotes: existingNotes,
    existingAllTechs: existingAllTechs,
    existingUrls: existingUrls,
    lastRow: ticketRows.length + 2
  };

}



// ต่างจาก SpreadsheetApp ที่ setValues/appendRow ขยายจำนวน
// แถวของ grid ให้อัตโนมัติเวลาข้อมูลเกินขนาดปัจจุบัน —
// values.batchUpdate ของ Sheets API ไม่ขยายให้ ถ้า range
// ที่จะเขียนเกิน gridProperties.rowCount ปัจจุบัน จะได้
// error "exceeds grid limits" ทันที (เจอจริงกับ sync-tickets.js
// ตอนย้ายไปชีทใหม่ที่มี grid เล็กกว่าจำนวนแถวที่ต้องเขียน)
async function readGridRowCount(sheets, spreadsheetId, sheetId) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: spreadsheetId,
    fields: 'sheets(properties(sheetId,gridProperties))'
  });
  const sheet = meta.data.sheets.find(function(s) { return s.properties.sheetId === sheetId; });
  return sheet ? sheet.properties.gridProperties.rowCount : 0;
}

async function ensureGridSize(sheets, spreadsheetId, sheetId, requiredRows) {

  let currentRows = await readGridRowCount(sheets, spreadsheetId, sheetId);

  if (requiredRows <= currentRows) {
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId,
    requestBody: {
      requests: [{
        updateSheetProperties: {
          properties: {
            sheetId: sheetId,
            gridProperties: { rowCount: requiredRows + 500 }
          },
          fields: 'gridProperties.rowCount'
        }
      }]
    }
  });

  // เจอจริงบน sync-tickets.js ว่าขยายเสร็จแล้ว แต่
  // values.batchUpdate ที่ยิงตามมาติดๆ ยัง error "exceeds
  // grid limits" อยู่ — น่าจะเป็น eventual consistency ฝั่ง
  // Google เช็คย้ำ+รอสั้นๆ ก่อนไปต่อกันไว้
  for (let attempt = 0; attempt < 4; attempt++) {
    currentRows = await readGridRowCount(sheets, spreadsheetId, sheetId);
    if (requiredRows <= currentRows) {
      return;
    }
    await sleep(750);
  }

}



// ล้างข้อมูลเดิมในชีทตั้งแต่แถว 3 ลงไป (A3:Z) และเขียนข้อมูลชุดใหม่อย่างเป็นระเบียบ (Clean Refresh)
// โดยคงค่า Review (Col L) และ Note (Col M) เดิมที่มีในตั๋วและช่างช่วงนี้ไว้
async function clearAndWriteGasolineRows(sheets, spreadsheetId, sheetId, sheetName, rows, ctx, urlMap, techMap, lastSync) {

  // 1. ล้างข้อมูลเก่าตั้งแต่แถว 3 ลงไปทั้งหมด (A3:Z) ก่อนเขียนใหม่ทุกครั้ง
  try {
    await sheets.spreadsheets.values.clear({
      spreadsheetId: spreadsheetId,
      range: "'" + sheetName + "'!A3:Z"
    });
    console.log('ล้างข้อมูลเก่าในชีท "' + sheetName + '" (A3:Z) เรียบร้อยแล้ว');
  } catch (err) {
    console.log('เตือน: ล้างข้อมูลชีทไม่สำเร็จ: ' + err.message);
  }

  if (rows.length === 0) {
    ctx.lastRow = 2;
    return 2;
  }

  // 2. Deduplicate rows โดย composite key: Ticket No + Technician Name
  const uniqueRows = new Map();
  rows.forEach(function(r) {
    const ticketKey = String(r.ticketNo || '').trim();
    const techKey = String(r.technician || '').trim();
    if (ticketKey) {
      uniqueRows.set(ticketKey + '__' + techKey, r);
    }
  });

  const targetRowCount = uniqueRows.size + 2;
  await ensureGridSize(sheets, spreadsheetId, sheetId, targetRowCount);

  // 3. ประกอบ Data Rows ทั้งหมดตั้งแต่แถว 3 เป็นต้นไป
  const fullRows = [];
  let rowNum = 3;

  uniqueRows.forEach(function(r) {
    const ticketKey = String(r.ticketNo || '').trim();
    const techKey = String(r.technician || '').trim();
    const parentKey = ticketKey.replace(/\.[A-Z0-9]+$/i, '').trim();

    // All Technicians (Col F):
    // ลำดับ: จาก techMap (Trick2) -> จาก Gasoline Detail เดิม -> fallback: r.technician
    const allTechs = techMap[ticketKey] ||
      (parentKey && techMap[parentKey]) ||
      (ctx.existingAllTechs && ctx.existingAllTechs[ticketKey]) ||
      (parentKey && ctx.existingAllTechs && ctx.existingAllTechs[parentKey]) ||
      r.technician ||
      '';

    // URL (Col K):
    const url = urlMap[ticketKey] ||
      (parentKey && urlMap[parentKey]) ||
      (ctx.existingUrls && ctx.existingUrls[ticketKey]) ||
      (parentKey && ctx.existingUrls && ctx.existingUrls[parentKey]) ||
      '';

    // Review (Col L) และ Note (Col M):
    const compKey = ticketKey + '__' + techKey;
    const review = (ctx.existingReviews && (ctx.existingReviews[compKey] || ctx.existingReviews[ticketKey])) || '';
    const note = (ctx.existingNotes && (ctx.existingNotes[compKey] || ctx.existingNotes[ticketKey])) || '';

    fullRows.push([
      r.arrivedDate,
      r.jobNo,
      ticketKey,
      r.customer,
      techKey,
      allTechs,
      r.team,
      r.counted,
      r.remarks,
      lastSync,
      url,
      review,
      note,
      countStackFormula(rowNum),
      amountFormula(rowNum)
    ]);
    rowNum++;
  });

  // 4. เขียนชุดข้อมูลใหม่ทั้งหมดลงชีทในคำขอเดียว
  if (fullRows.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: spreadsheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [{
          range: "'" + sheetName + "'!A3:O" + (2 + fullRows.length),
          values: fullRows
        }]
      }
    });
  }

  // อัปเดต ctx.lastRow เพื่อให้ขั้นตอนถัดไปใช้งาน
  ctx.lastRow = 2 + fullRows.length;
  return ctx.lastRow;

}

// Alias สำหรับ backward compatibility
const upsertRows = clearAndWriteGasolineRows;



async function getSheetIdByName(sheets, spreadsheetId, sheetName) {

  const meta = await sheets.spreadsheets.get({ spreadsheetId: spreadsheetId });
  const sheet = meta.data.sheets.find(function(s) {
    return s.properties.title === sheetName;
  });

  return sheet ? sheet.properties.sheetId : null;

}



// แทนที่ applyGasolineReviewValidation_ ใน gasoline.js
// (Sheets API ไม่มี "setDataValidation" แบบ Range object
// ตรงๆ เหมือน SpreadsheetApp ต้องยิง batchUpdate request
// แบบ raw พร้อม sheetId ตัวเลข ไม่ใช่ชื่อชีท)
async function applyReviewValidation(sheets, spreadsheetId, sheetId, lastRow) {

  if (lastRow < 3 || sheetId === null || sheetId === undefined) {
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId,
    requestBody: {
      requests: [{
        setDataValidation: {
          range: {
            sheetId: sheetId,
            startRowIndex: 2,
            endRowIndex: lastRow,
            startColumnIndex: 11,
            endColumnIndex: 12
          },
          rule: {
            condition: {
              type: 'ONE_OF_LIST',
              values: [
                { userEnteredValue: 'Approved' },
                { userEnteredValue: 'Not Approved' }
              ]
            },
            strict: true,
            showCustomUi: true
          }
        }
      }]
    }
  });

}



function formatLastSync(date) {

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(date);

  const get = function(type) {
    return parts.find(function(p) { return p.type === type; }).value;
  };

  return get('day') + '/' + get('month') + '/' + get('year') + ' ' +
    get('hour') + ':' + get('minute') + ':' + get('second');

}



/*************************************************
 * ROCKET URL & TECHNICIANS LOOKUP & BACKFILL
 * หลัง sync เสร็จ ให้เช็ค All Technicians (F) และ URL (K)
 * ถ้าช่องไหนว่าง ให้ไปดึงมาจาก Trick2 หรือ Rocket มาเติมเอง
 *************************************************/

function computeSearchRange(arrivedDate) {
  let refDate = new Date();
  if (arrivedDate) {
    const parts = arrivedDate.split('/');
    if (parts.length === 3) {
      const d = Number(parts[0]);
      const m = Number(parts[1]) - 1;
      const y = Number(parts[2]);
      const parsed = new Date(y, m, d);
      if (!isNaN(parsed.getTime())) {
        refDate = parsed;
      }
    }
  }

  // ค้นหาย้อนหลัง 1 ปี จากวันที่ถึงหน้างาน เพื่อให้ครอบคลุมตั๋วเก่า
  const startDate = new Date(refDate.getFullYear() - 1, refDate.getMonth(), refDate.getDate());
  const now = new Date();
  const endDate = refDate > now ? refDate : now;

  function fmt(dt) {
    const dd = String(dt.getDate()).padStart(2, '0');
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    return dd + '/' + mm + '/' + dt.getFullYear();
  }

  return { start: fmt(startDate), end: fmt(endDate) };
}

function extractParentTicketId(html, targetNo) {
  if (!html) return null;
  if (targetNo) {
    const cleanTarget = targetNo.trim();
    const baseNo = cleanTarget.replace(/\.[A-Z0-9]+$/i, '').trim();

    for (const num of [cleanTarget, baseNo]) {
      if (!num) continue;
      const escaped = rocket.escapeRegex(num);
      const rowRegex = new RegExp('<tr[^>]*>[\\s\\S]*?' + escaped + '[\\s\\S]*?ticket_view\\.php\\?id=(\\d+)[\\s\\S]*?<\\/tr>', 'i');
      const rowMatch = html.match(rowRegex);
      if (rowMatch) return rowMatch[1];

      const rowRegex2 = new RegExp('<tr[^>]*>[\\s\\S]*?ticket_view\\.php\\?id=(\\d+)[\\s\\S]*?' + escaped + '[\\s\\S]*?<\\/tr>', 'i');
      const rowMatch2 = html.match(rowRegex2);
      if (rowMatch2) return rowMatch2[1];
    }
  }

  const allIds = rocket.extractParentTicketIds(html);
  if (allIds.length === 1) {
    return allIds[0];
  }
  return allIds.length > 0 ? allIds[0] : null;
}

async function fetchTicketInfoFromRocket(auth, ticketNo, jobNo, arrivedDate) {
  const cleanTicketNo = (ticketNo || '').trim();
  const cleanJobNo = (jobNo || '').trim();

  // เลข Parent Ticket ต้องสกัดจาก cleanTicketNo เป็นหลัก
  // เช่น BKIN0826-000040.R01 -> BKIN0826-000040
  // ไม่ใช้ cleanJobNo (เช่น "00750" หรือ "ใบงานเปล่า") เพราะเป็นเลขใบงานภายใน ไม่ใช่เลขตั๋ว Rocket
  let parentNo = '';
  if (cleanTicketNo) {
    parentNo = cleanTicketNo.replace(/\.[A-Z0-9]+$/i, '').trim();
  } else if (cleanJobNo && /^BK[A-Z]{2}\d{4}-\d+/i.test(cleanJobNo)) {
    parentNo = cleanJobNo.replace(/\.[A-Z0-9]+$/i, '').trim();
  }

  if (!parentNo && !cleanTicketNo) {
    return { url: '', technicians: '' };
  }

  const searchRange = computeSearchRange(arrivedDate);
  const searchTerms = [parentNo, cleanTicketNo].filter(Boolean);
  const uniqueTerms = [...new Set(searchTerms)];

  let parentId = null;

  for (const term of uniqueTerms) {
    // 1. ค้นหาแบบระบุช่วงวันที่ (date_type=1 วันที่เปิดตั๋ว)
    try {
      const html = await rocket.getParentTicketHtml(auth, searchRange.start, searchRange.end, '1', term);
      parentId = extractParentTicketId(html, term);
      if (parentId) break;
    } catch (e) {}

    // 2. ค้นหาแบบระบุช่วงวันที่ (date_type=2 วันที่นัดหมาย)
    try {
      const html = await rocket.getParentTicketHtml(auth, searchRange.start, searchRange.end, '2', term);
      parentId = extractParentTicketId(html, term);
      if (parentId) break;
    } catch (e) {}

    // 3. ค้นหาแบบไม่จำกัดวันที่ (เผื่อตั๋วสร้างก่อนช่วงที่คำนวณ)
    try {
      const html = await rocket.getParentTicketHtml(auth, '', '', '1', term);
      parentId = extractParentTicketId(html, term);
      if (parentId) break;
    } catch (e) {}
  }

  if (!parentId) {
    return { url: '', technicians: '' };
  }

  try {
    const checkRepairHtml = await rocket.getCheckRepairHtml(parentId, auth);
    const subIds = rocket.extractCheckRepairIds(checkRepairHtml);
    const checkRepairInfo = rocket.extractCheckRepairInfo(checkRepairHtml);

    // ดึง technicians จากตาราง "ตรวจเช็ค/เข้าซ่อม"
    let techs = '';
    if (checkRepairInfo[cleanTicketNo] && checkRepairInfo[cleanTicketNo].technicians) {
      techs = checkRepairInfo[cleanTicketNo].technicians;
    }
    if (!techs) {
      for (const sId of subIds) {
        if (checkRepairInfo[sId] && checkRepairInfo[sId].technicians) {
          techs = checkRepairInfo[sId].technicians;
          break;
        }
      }
    }

    // หา Sub Ticket ID ที่ตรงกับ cleanTicketNo
    let matchedSubId = null;

    if (checkRepairInfo[cleanTicketNo] && checkRepairInfo[cleanTicketNo].subId) {
      matchedSubId = checkRepairInfo[cleanTicketNo].subId;
    }

    if (!matchedSubId && subIds.length > 1) {
      const trRegex = /<tr\s+id=["']tr_(\d+)["'][^>]*>([\s\S]*?)<\/tr>/gi;
      let trMatch;
      while ((trMatch = trRegex.exec(checkRepairHtml)) !== null) {
        const sId = trMatch[1];
        const trContent = trMatch[2];
        if (cleanTicketNo && trContent.includes(cleanTicketNo)) {
          matchedSubId = sId;
          if (!techs && checkRepairInfo[sId] && checkRepairInfo[sId].technicians) {
            techs = checkRepairInfo[sId].technicians;
          }
          break;
        }
      }
    }

    if (!matchedSubId && subIds.length === 1) {
      matchedSubId = subIds[0];
    }

    if (!matchedSubId && subIds.length > 1) {
      for (const sId of subIds) {
        try {
          const detailHtml = await rocket.getTicketDetailHtml(sId, auth);
          const parsed = rocket.parseTicketDetail(detailHtml, sId);
          if (parsed.ticketNo && cleanTicketNo && parsed.ticketNo === cleanTicketNo) {
            matchedSubId = sId;
            break;
          }
        } catch (e) {}
      }
    }

    if (!matchedSubId && subIds.length > 0) {
      matchedSubId = subIds[0];
    }

    let foundUrl = '';
    if (matchedSubId) {
      foundUrl = `${rocket.ROCKET_BASE}/main/ticket_checkrepair_view.php?id=${matchedSubId}`;
    } else {
      foundUrl = `${rocket.ROCKET_BASE}/main/ticket_view.php?id=${parentId}`;
    }

    return { url: foundUrl, technicians: techs };

  } catch (err) {
    console.log('ดึง checkrepair สำหรับ parentId=' + parentId + ' ล้มเหลว: ' + err.message);
    return { url: `${rocket.ROCKET_BASE}/main/ticket_view.php?id=${parentId}`, technicians: '' };
  }
}

async function backfillMissingDataFromRocket(sheets, spreadsheetId, sheetName, auth, urlMap, techMap) {

  console.log('--- ตรวจสอบคอลัมน์ All Technicians (F) และ URL (K) หลัง Sync ---');

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId,
    range: "'" + sheetName + "'!A3:K"
  });

  const rows = res.data.values || [];
  if (rows.length === 0) {
    console.log('ชีทว่างเปล่า — ข้ามการตรวจข้อมูล');
    return;
  }

  console.log('กำลังตรวจสอบข้อมูลทั้งหมด ' + rows.length + ' แถวในชีท...');

  const missing = [];
  let skippedNoIdentifier = 0;

  rows.forEach(function(row, i) {
    const rowNum = i + 3;
    const jobNo = String(row[1] || '').trim();
    const ticketNo = String(row[2] || '').trim();
    const technicianName = String(row[4] || '').trim(); // Col E: Technician Name
    const allTechs = String(row[5] || '').trim();       // Col F: All Technicians
    const url = String(row[10] || '').trim();           // Col K: URL

    const identifier = ticketNo || jobNo;
    if (!identifier) {
      skippedNoIdentifier++;
      return;
    }

    if (!allTechs || !url) {
      missing.push({
        rowNum: rowNum,
        arrivedDate: String(row[0] || '').trim(),
        jobNo: jobNo,
        ticketNo: ticketNo,
        technicianName: technicianName,
        needTechs: !allTechs,
        needUrl: !url
      });
    }
  });

  if (skippedNoIdentifier > 0) {
    console.log('พบแถวที่ไม่มีทั้ง Job No และ Ticket No: ' + skippedNoIdentifier + ' แถว (ข้าม)');
  }

  if (missing.length === 0) {
    console.log('คอลัมน์ All Technicians และ URL ครบถ้วนทุกแถว (' + rows.length + ' แถว) — ไม่มีช่องว่าง');
    return;
  }

  console.log('พบแถวที่ต้องเติมข้อมูล ' + missing.length + ' แถว:');
  missing.forEach(function(m) {
    const missingList = [];
    if (m.needTechs) missingList.push('All Technicians');
    if (m.needUrl) missingList.push('URL');
    console.log('  - แถว ' + m.rowNum + ': Ticket=' + (m.ticketNo || '-') + ', Job=' + (m.jobNo || '-') + ' ขาด [' + missingList.join(', ') + ']');
  });

  const updates = [];
  const rocketInfoCache = {};
  let filledTechsCount = 0;
  let filledUrlsCount = 0;

  for (const item of missing) {
    try {
      const parentNo = item.ticketNo.replace(/\.[A-Z0-9]+$/i, '').trim();

      let foundTechs = item.needTechs ? (techMap[item.ticketNo] || (parentNo ? techMap[parentNo] : '')) : '';
      let foundUrl = item.needUrl ? (urlMap[item.ticketNo] || (parentNo ? urlMap[parentNo] : '')) : '';

      // ตรวจแคชรอบนี้ (เฉพาะ ticketNo หรือ parentNo)
      if ((item.needTechs && !foundTechs) || (item.needUrl && !foundUrl)) {
        const cached = rocketInfoCache[item.ticketNo] || (parentNo ? rocketInfoCache[parentNo] : null);
        if (cached) {
          if (item.needTechs && !foundTechs && cached.technicians) foundTechs = cached.technicians;
          if (item.needUrl && !foundUrl && cached.url) foundUrl = cached.url;
        }
      }

      // ถ้ายังขาด ให้ยิง Rocket ด้วย item.ticketNo
      if ((item.needTechs && !foundTechs) || (item.needUrl && !foundUrl)) {
        const info = await fetchTicketInfoFromRocket(auth, item.ticketNo, item.jobNo, item.arrivedDate);
        if (info) {
          rocketInfoCache[item.ticketNo] = info;
          if (parentNo) rocketInfoCache[parentNo] = info;
          if (item.needTechs && !foundTechs && info.technicians) foundTechs = info.technicians;
          if (item.needUrl && !foundUrl && info.url) foundUrl = info.url;
        }
        await sleep(250);
      }

      // Fallback สำหรับ All Technicians: ถ้ายังหาไม่เจอ ให้ใช้ Technician Name (Col E)
      if (item.needTechs && !foundTechs && item.technicianName) {
        foundTechs = item.technicianName;
      }

      if (item.needTechs && foundTechs) {
        updates.push({
          range: "'" + sheetName + "'!F" + item.rowNum,
          values: [[foundTechs]]
        });
        filledTechsCount++;
        console.log('แถว ' + item.rowNum + ' [' + item.ticketNo + ']: เติม All Technicians -> ' + foundTechs);
      }

      if (item.needUrl && foundUrl) {
        updates.push({
          range: "'" + sheetName + "'!K" + item.rowNum,
          values: [[foundUrl]]
        });
        filledUrlsCount++;
        console.log('แถว ' + item.rowNum + ' [' + item.ticketNo + ']: เติม URL -> ' + foundUrl);
      }

    } catch (err) {
      console.log('แถว ' + item.rowNum + ' [' + item.ticketNo + '] เกิดข้อผิดพลาด: ' + err.message);
    }
  }

  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: spreadsheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: updates
      }
    });
    console.log('อัปเดตสำเร็จ: เติม All Technicians ' + filledTechsCount + ' แถว, เติม URL ' + filledUrlsCount + ' แถว');
  } else {
    console.log('ไม่พบข้อมูลเพิ่มเติมที่สามารถเติมได้');
  }

}



/*************************************************
 * MAIN
 *************************************************/

async function main() {

  console.log('========== GASOLINE TEAM SYNC (Node.js / GitHub Actions) ==========');

  const auth = await rocket.rocketLogin();
  console.log('LOGIN OK');

  const range = computeDateRange(process.env.GASOLINE_START_DATE, process.env.GASOLINE_END_DATE);
  console.log('ช่วงวันที่: ' + range.start + ' - ' + range.end);

  let rows = [];

  for (const team of GASOLINE_TEAM_IDS) {
    const xlsxBuffer = await fetchGasolineTeamXlsx(auth, team.id, range);
    const teamRows = extractGasolineTeamRows(xlsxBuffer);
    console.log('ทีม ' + team.label + ': พบ ' + teamRows.length + ' แถว');
    rows = rows.concat(teamRows);
  }

  console.log('รวมทั้งหมด ' + rows.length + ' แถว (4 ทีม)');

  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new Error('ไม่พบ SPREADSHEET_ID ใน environment variables');
  }

  const sheets = await getSheetsClient();

  const sheetId = await getSheetIdByName(sheets, spreadsheetId, GASOLINE_SHEET_NAME);
  const urlMap = await getTicketNoToUrlMap(sheets, spreadsheetId);
  const techMap = await getTrick2TechniciansMap(sheets, spreadsheetId);
  const ctx = await buildRowIndex(sheets, spreadsheetId, GASOLINE_SHEET_NAME, sheetId, range, rows.length);
  const lastSync = formatLastSync(new Date());

  const lastRow = await clearAndWriteGasolineRows(sheets, spreadsheetId, sheetId, GASOLINE_SHEET_NAME, rows, ctx, urlMap, techMap, lastSync);

  await applyReviewValidation(sheets, spreadsheetId, sheetId, lastRow);

  console.log('DONE — เขียนลงชีท "' + GASOLINE_SHEET_NAME + '" แล้ว (clear & rewrite ' + (lastRow - 2) + ' แถว)');

  // หลัง sync เสร็จ ให้ตรวจสอบคอลัมน์ All Technicians (Column F) และ URL (Column K) ถ้าช่องไหนว่างให้ดึงมาเติม
  await backfillMissingDataFromRocket(sheets, spreadsheetId, GASOLINE_SHEET_NAME, auth, urlMap, techMap);

}

main().catch(function(err) {
  console.error('Sync ล้มเหลว:', err);
  process.exit(1);
});
