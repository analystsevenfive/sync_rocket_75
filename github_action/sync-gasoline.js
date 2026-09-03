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

const GASOLINE_WINDOW_DAYS = 30;

// เดิม hardcode วันที่ไว้ตายตัว ('30/07/2026'-'29/08/2026')
// ใช้ทดสอบครั้งแรกได้ แต่ตั้ง cron รันทุกชั่วโมงไม่ได้
// เพราะช่วงวันที่จะไม่ขยับตามเวลาจริงเลย — เปลี่ยนเป็น
// rolling N วันล่าสุด (ตามเวลากรุงเทพ) แทน
function computeRollingRangeBangkok(daysBack) {

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

  const now = bangkokDateParts(new Date());
  const end = fmt(now.year, now.month, now.day);

  const startDate = new Date(now.year, now.month - 1, now.day - daysBack);
  const start = fmt(startDate.getFullYear(), startDate.getMonth() + 1, startDate.getDate());

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

  const res = await fetch(
    ROCKET_BASE + '/main/ajax/report_ticket/gasoline/export_cost_team.php',
    { method: 'POST', headers: headers, body: body }
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
    range: "'" + TICKETS_SHEET_NAME + "'!A1:AH"
  });

  const values = res.data.values || [];
  if (values.length < 2) {
    return {};
  }

  const headers = values[0];
  const ticketNoCol = headers.indexOf('Ticket No');
  const parentTicketNoCol = headers.indexOf('Parent Ticket No');
  const urlCol = headers.indexOf('URL');

  const map = {};

  for (let i = 1; i < values.length; i++) {
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
      if (ticketNo && allTechs) {
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
    '$E$2:E' + rowNum + ',E' + rowNum + ',' +
    '$H$2:H' + rowNum + ',">0",' +
    '$L$2:L' + rowNum + ',"Approved"),"")'
  );
}



function amountFormula(rowNum) {
  return '=IF(N' + rowNum + '="","",N' + rowNum + '*' + RATE_PER_JOB + ')';
}



// แทนที่ buildGasolineDetailRowIndex_ ใน gasoline.js
async function buildRowIndex(sheets, spreadsheetId, sheetName) {

  await sheets.spreadsheets.values.update({
    spreadsheetId: spreadsheetId,
    range: "'" + sheetName + "'!A1:O1",
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [GASOLINE_DETAIL_HEADERS] }
  });

  const valuesRes = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId,
    range: "'" + sheetName + "'!A2:K"
  });

  const formulaRes = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId,
    range: "'" + sheetName + "'!N2:N",
    valueRenderOption: 'FORMULA'
  });

  const ticketRows = valuesRes.data.values || [];
  const formulaRows = formulaRes.data.values || [];

  const index = {};
  const existingAllTechs = {};
  const existingUrls = {};
  const hasFormula = {};

  ticketRows.forEach(function(row, i) {
    const jobNo = String(row[1] || '').trim();
    const ticketNo = String(row[2] || '').trim();
    const allTechs = String(row[5] || '').trim();
    const existingUrl = String(row[10] || '').trim();
    const rowNum = i + 2;

    if (ticketNo) index[ticketNo] = rowNum;
    if (jobNo && !index[jobNo]) index[jobNo] = rowNum;

    if (allTechs) {
      if (ticketNo) existingAllTechs[ticketNo] = allTechs;
      if (jobNo && !existingAllTechs[jobNo]) existingAllTechs[jobNo] = allTechs;
    }
    if (existingUrl) {
      if (ticketNo) existingUrls[ticketNo] = existingUrl;
      if (jobNo && !existingUrls[jobNo]) existingUrls[jobNo] = existingUrl;
    }
    hasFormula[rowNum] = Boolean(formulaRows[i] && formulaRows[i][0]);
  });

  return {
    index: index,
    existingAllTechs: existingAllTechs,
    existingUrls: existingUrls,
    hasFormula: hasFormula,
    lastRow: ticketRows.length + 1
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



// แทนที่ batchUpsertGasolineDetail_ ใน gasoline.js —
// logic เดียวกันเป๊ะ (upsert คีย์ Ticket No, เขียนทับ
// A:K แถวเดิม, backfill สูตร N:O ถ้าขาด, แถวใหม่
// เขียนเต็ม A:O)
async function upsertRows(sheets, spreadsheetId, sheetId, sheetName, rows, ctx, urlMap, techMap, lastSync) {

  if (rows.length === 0) {
    return;
  }

  const data = [];
  const newRows = [];

  rows.forEach(function(r) {

    const ticketKey = String(r.ticketNo).trim();
    const jobKey = String(r.jobNo || '').trim();

    // 1. All Technicians:
    // ลำดับ: จาก techMap (Trick2) -> จาก Gasoline Detail เดิม -> fallback: r.technician
    const allTechs = techMap[ticketKey] ||
      (jobKey && techMap[jobKey]) ||
      (ctx.existingAllTechs && ctx.existingAllTechs[ticketKey]) ||
      (jobKey && ctx.existingAllTechs && ctx.existingAllTechs[jobKey]) ||
      r.technician ||
      '';

    // 2. URL:
    const url = urlMap[ticketKey] ||
      (jobKey && urlMap[jobKey]) ||
      (ctx.existingUrls && ctx.existingUrls[ticketKey]) ||
      (jobKey && ctx.existingUrls && ctx.existingUrls[jobKey]) ||
      '';

    const dataRow = [
      r.arrivedDate, r.jobNo, r.ticketNo, r.customer,
      r.technician, allTechs, r.team, r.counted, r.remarks,
      lastSync, url
    ];

    const existingRow = ctx.index[r.ticketNo] || ctx.index[ticketKey];

    if (existingRow) {

      data.push({
        range: "'" + sheetName + "'!A" + existingRow + ':K' + existingRow,
        values: [dataRow]
      });

      if (!ctx.hasFormula[existingRow]) {
        data.push({
          range: "'" + sheetName + "'!N" + existingRow + ':O' + existingRow,
          values: [[countStackFormula(existingRow), amountFormula(existingRow)]]
        });
        ctx.hasFormula[existingRow] = true;
      }

    } else {

      newRows.push({ ticketNo: r.ticketNo, dataRow: dataRow });

    }

  });

  if (newRows.length > 0) {

    const startRow = ctx.lastRow + 1;

    const fullRows = newRows.map(function(nr, i) {
      const rowNum = startRow + i;
      return nr.dataRow.concat([
        '', '', countStackFormula(rowNum), amountFormula(rowNum)
      ]);
    });

    data.push({
      range: "'" + sheetName + "'!A" + startRow + ':O' + (startRow + newRows.length - 1),
      values: fullRows
    });

    newRows.forEach(function(nr, i) {
      ctx.index[nr.ticketNo] = startRow + i;
    });

    ctx.lastRow += newRows.length;

    await ensureGridSize(sheets, spreadsheetId, sheetId, ctx.lastRow);

  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data: data }
  });

}



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

  if (lastRow < 2 || sheetId === null || sheetId === undefined) {
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId,
    requestBody: {
      requests: [{
        setDataValidation: {
          range: {
            sheetId: sheetId,
            startRowIndex: 1,
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
    range: "'" + sheetName + "'!A2:K"
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
    const rowNum = i + 2;
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
      let foundTechs = item.needTechs ? (techMap[item.ticketNo] || (item.jobNo ? techMap[item.jobNo] : '')) : '';
      let foundUrl = item.needUrl ? (urlMap[item.ticketNo] || (item.jobNo ? urlMap[item.jobNo] : '')) : '';

      // ตรวจแคชรอบนี้
      if ((item.needTechs && !foundTechs) || (item.needUrl && !foundUrl)) {
        const cached = rocketInfoCache[item.ticketNo] || (item.jobNo ? rocketInfoCache[item.jobNo] : null);
        if (cached) {
          if (item.needTechs && !foundTechs && cached.technicians) foundTechs = cached.technicians;
          if (item.needUrl && !foundUrl && cached.url) foundUrl = cached.url;
        }
      }

      // ถ้ายังขาด ให้ยิง Rocket
      if ((item.needTechs && !foundTechs) || (item.needUrl && !foundUrl)) {
        const info = await fetchTicketInfoFromRocket(auth, item.ticketNo, item.jobNo, item.arrivedDate);
        if (info) {
          rocketInfoCache[item.ticketNo] = info;
          if (item.jobNo) rocketInfoCache[item.jobNo] = info;
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

  const range = computeRollingRangeBangkok(GASOLINE_WINDOW_DAYS);
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

  const urlMap = await getTicketNoToUrlMap(sheets, spreadsheetId);
  const techMap = await getTrick2TechniciansMap(sheets, spreadsheetId);
  const ctx = await buildRowIndex(sheets, spreadsheetId, GASOLINE_SHEET_NAME);
  const lastSync = formatLastSync(new Date());

  const sheetId = await getSheetIdByName(sheets, spreadsheetId, GASOLINE_SHEET_NAME);
  await upsertRows(sheets, spreadsheetId, sheetId, GASOLINE_SHEET_NAME, rows, ctx, urlMap, techMap, lastSync);

  await applyReviewValidation(sheets, spreadsheetId, sheetId, ctx.lastRow);

  console.log('DONE — เขียนลงชีท "' + GASOLINE_SHEET_NAME + '" แล้ว (upsert)');

  // หลัง sync เสร็จ ให้ตรวจสอบคอลัมน์ All Technicians (Column F) และ URL (Column K) ถ้าช่องไหนว่างให้ดึงมาเติม
  await backfillMissingDataFromRocket(sheets, spreadsheetId, GASOLINE_SHEET_NAME, auth, urlMap, techMap);

}

main().catch(function(err) {
  console.error('Sync ล้มเหลว:', err);
  process.exit(1);
});
