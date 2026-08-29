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
 * เขียนลงชีท "Gasoline Detail (Test)" เหมือนฝั่ง Apps
 * Script ก่อน (ยังไม่ชี้ไป production sheet) เพื่อ
 * เทียบผลลัพธ์ว่าพอร์ตมาถูกต้องตรงกันหรือไม่ ก่อนค่อย
 * เปลี่ยนชื่อชีทปลายทางทีหลัง
 *************************************************/

const { google } = require('googleapis');
const XLSX = require('xlsx');

const ROCKET_BASE = 'https://rocket75.com';
const TICKETS_SHEET_NAME = 'Tickets';
const GASOLINE_SHEET_NAME = 'Gasoline Detail (Test)';
const RATE_PER_JOB = 80;

// ช่วงวันที่เดียวกับที่ทดสอบบน Apps Script — ตั้งตรงนี้
// ไว้ก่อน ยังไม่ทำเป็น rolling window อัตโนมัติ
const START_DATE = '30/07/2026';
const END_DATE = '29/08/2026';

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

async function fetchGasolineTeamXlsx(auth, teamId) {

  const body = new URLSearchParams();
  body.set('start_date', START_DATE);
  body.set('end_date', END_DATE);
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
  const urlCol = headers.indexOf('URL');

  const map = {};

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const ticketNo = row[ticketNoCol];
    if (ticketNo) {
      map[ticketNo] = row[urlCol] || '';
    }
  }

  return map;

}



function countStackFormula(rowNum) {
  return (
    '=IF(AND(G' + rowNum + '>0,K' + rowNum + '="Approved"),' +
    'COUNTIFS(' +
    '$E$2:E' + rowNum + ',E' + rowNum + ',' +
    '$G$2:G' + rowNum + ',">0",' +
    '$K$2:K' + rowNum + ',"Approved"),"")'
  );
}



function amountFormula(rowNum) {
  return '=IF(M' + rowNum + '="","",M' + rowNum + '*' + RATE_PER_JOB + ')';
}



// แทนที่ buildGasolineDetailRowIndex_ ใน gasoline.js
async function buildRowIndex(sheets, spreadsheetId, sheetName) {

  await sheets.spreadsheets.values.update({
    spreadsheetId: spreadsheetId,
    range: "'" + sheetName + "'!A1:N1",
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [GASOLINE_DETAIL_HEADERS] }
  });

  const valuesRes = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId,
    range: "'" + sheetName + "'!A2:C"
  });

  const formulaRes = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId,
    range: "'" + sheetName + "'!M2:M",
    valueRenderOption: 'FORMULA'
  });

  const ticketRows = valuesRes.data.values || [];
  const formulaRows = formulaRes.data.values || [];

  const index = {};
  const hasFormula = {};

  ticketRows.forEach(function(row, i) {
    const ticketNo = row[2];
    if (ticketNo) {
      const rowNum = i + 2;
      index[ticketNo] = rowNum;
      hasFormula[rowNum] = Boolean(formulaRows[i] && formulaRows[i][0]);
    }
  });

  return {
    index: index,
    hasFormula: hasFormula,
    lastRow: ticketRows.length + 1
  };

}



// แทนที่ batchUpsertGasolineDetail_ ใน gasoline.js —
// logic เดียวกันเป๊ะ (upsert คีย์ Ticket No, เขียนทับ
// แค่ A:J แถวเดิม, backfill สูตร M:N ถ้าขาด, แถวใหม่
// เขียนเต็ม A:N)
async function upsertRows(sheets, spreadsheetId, sheetName, rows, ctx, urlMap, lastSync) {

  if (rows.length === 0) {
    return;
  }

  const data = [];
  const newRows = [];

  rows.forEach(function(r) {

    const url = urlMap[r.ticketNo] || '';

    const dataRow = [
      r.arrivedDate, r.jobNo, r.ticketNo, r.customer,
      r.technician, r.team, r.counted, r.remarks,
      lastSync, url
    ];

    const existingRow = ctx.index[r.ticketNo];

    if (existingRow) {

      data.push({
        range: "'" + sheetName + "'!A" + existingRow + ':J' + existingRow,
        values: [dataRow]
      });

      if (!ctx.hasFormula[existingRow]) {
        data.push({
          range: "'" + sheetName + "'!M" + existingRow + ':N' + existingRow,
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
      range: "'" + sheetName + "'!A" + startRow + ':N' + (startRow + newRows.length - 1),
      values: fullRows
    });

    newRows.forEach(function(nr, i) {
      ctx.index[nr.ticketNo] = startRow + i;
    });

    ctx.lastRow += newRows.length;

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
            startColumnIndex: 10,
            endColumnIndex: 11
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
 * MAIN
 *************************************************/

async function main() {

  console.log('========== GASOLINE TEAM SYNC (Node.js / GitHub Actions) ==========');

  const auth = await rocketLogin();
  console.log('LOGIN OK');

  let rows = [];

  for (const team of GASOLINE_TEAM_IDS) {
    const xlsxBuffer = await fetchGasolineTeamXlsx(auth, team.id);
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
  const ctx = await buildRowIndex(sheets, spreadsheetId, GASOLINE_SHEET_NAME);
  const lastSync = formatLastSync(new Date());

  await upsertRows(sheets, spreadsheetId, GASOLINE_SHEET_NAME, rows, ctx, urlMap, lastSync);

  const sheetId = await getSheetIdByName(sheets, spreadsheetId, GASOLINE_SHEET_NAME);
  await applyReviewValidation(sheets, spreadsheetId, sheetId, ctx.lastRow);

  console.log('DONE — เขียนลงชีท "' + GASOLINE_SHEET_NAME + '" แล้ว (upsert)');

}

main().catch(function(err) {
  console.error('Sync ล้มเหลว:', err);
  process.exit(1);
});
