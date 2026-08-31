/*************************************************
 * SHARED — Google Sheets API helpers (Node.js port
 * ของ SpreadsheetApp calls ที่ใช้ร่วมกันใน trick.js/
 * trick2.js/stage.js: getSheetsClient, columnLetter_,
 * generic upsert pattern, batch row-delete สำหรับ prune)
 *************************************************/

const { google } = require('googleapis');



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



function columnLetter(n) {
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}



async function getSheetIdByName(sheets, spreadsheetId, sheetName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: spreadsheetId });
  const sheet = meta.data.sheets.find(function(s) {
    return s.properties.title === sheetName;
  });
  return sheet ? sheet.properties.sheetId : null;
}



// ต่างจาก SpreadsheetApp ที่ ss.insertSheet(name) สร้าง
// แท็บใหม่ให้อัตโนมัติถ้ายังไม่มี — Sheets API ไม่ทำแบบ
// นั้น ถ้ายิง values.update ไปที่แท็บที่ยังไม่มีจะ error
// ทันที ต้องเช็ค+สร้างเองก่อนเสมอ (เรียกจาก main() ของ
// แต่ละ sync ก่อนเรียก ensureSheetAndBuildIndex อื่นๆ)
async function ensureSheetExists(sheets, spreadsheetId, sheetName) {

  const sheetId = await getSheetIdByName(sheets, spreadsheetId, sheetName);
  if (sheetId !== null) {
    return sheetId;
  }

  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: sheetName } } }]
    }
  });

  return res.data.replies[0].addSheet.properties.sheetId;

}



// ensureSheet: เขียน header ทับทุกครั้ง (กัน schema
// เปลี่ยนแล้ว header ค้างชื่อเก่า เหมือน buildTicketRowIndex_
// เดิม) แล้วอ่าน key column กลับมาสร้าง index (row map)
async function ensureSheetAndBuildIndex(sheets, spreadsheetId, sheetName, headers, keyColIndex1Based) {

  const lastCol = columnLetter(headers.length);

  await sheets.spreadsheets.values.update({
    spreadsheetId: spreadsheetId,
    range: "'" + sheetName + "'!A1:" + lastCol + '1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [headers] }
  });

  const keyCol = columnLetter(keyColIndex1Based);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId,
    range: "'" + sheetName + "'!" + keyCol + '2:' + keyCol
  });

  const values = res.data.values || [];
  const index = {};

  values.forEach(function(row, i) {
    if (row[0]) {
      index[String(row[0])] = i + 2;
    }
  });

  return { index: index, lastRow: values.length + 1 };

}



// ต่างจาก SpreadsheetApp ที่ setValues/appendRow ขยายจำนวน
// แถวของ grid ให้อัตโนมัติเวลาข้อมูลเกินขนาดปัจจุบัน —
// values.batchUpdate ของ Sheets API ไม่ขยายให้ ถ้า range
// ที่จะเขียนเกิน gridProperties.rowCount ปัจจุบัน จะได้
// error "exceeds grid limits" ทันที (เจอจริงตอนย้ายไปชีท
// ใหม่ที่มี grid แค่ 1934 แถว แต่ต้องเขียนถึงแถว 2447)
// ต้องเช็ค+ขยาย grid เองก่อนเขียนทุกครั้งที่มีแถวใหม่
async function ensureGridSize(sheets, spreadsheetId, sheetId, requiredRows) {

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: spreadsheetId,
    fields: 'sheets(properties(sheetId,gridProperties))'
  });

  const sheet = meta.data.sheets.find(function(s) { return s.properties.sheetId === sheetId; });
  const currentRows = sheet ? sheet.properties.gridProperties.rowCount : 0;

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

}



// batchUpsert ทั่วไป — key อยู่คอลัมน์ไหนก็ได้ (1-based)
// rows แต่ละตัวต้องมี property "key" (string) กับ "row"
// (array ของค่าตามลำดับคอลัมน์เต็ม A..lastCol) — ต้องส่ง
// sheetId (ตัวเลข จาก ensureSheetExists) มาด้วย เผื่อต้อง
// ขยาย grid ก่อนเขียน
async function batchUpsert(sheets, spreadsheetId, sheetId, sheetName, headers, ctx, rows) {

  if (rows.length === 0) {
    return;
  }

  const lastCol = columnLetter(headers.length);
  const data = [];
  const newRows = [];

  rows.forEach(function(r) {
    const existingRow = ctx.index[r.key];
    if (existingRow) {
      data.push({
        range: "'" + sheetName + "'!A" + existingRow + ':' + lastCol + existingRow,
        values: [r.row]
      });
    } else {
      newRows.push(r);
    }
  });

  if (newRows.length > 0) {
    const startRow = ctx.lastRow + 1;
    data.push({
      range: "'" + sheetName + "'!A" + startRow + ':' + lastCol + (startRow + newRows.length - 1),
      values: newRows.map(function(r) { return r.row; })
    });
    newRows.forEach(function(r, i) {
      ctx.index[r.key] = startRow + i;
    });
    ctx.lastRow += newRows.length;

    await ensureGridSize(sheets, spreadsheetId, sheetId, ctx.lastRow);
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data: data }
  });

}



// pruneStaleRows: ลบแถวที่ key ไม่อยู่ใน validKeys ชุด
// ล่าสุด — รวมแถวติดกันเป็นช่วงต่อเนื่องแล้วยิง
// batchUpdate (spreadsheets.batchUpdate ไม่ใช่ values.
// batchUpdate) ครั้งเดียวจบเหมือนที่แก้ไว้ใน trick.js
async function pruneStaleRows(sheets, spreadsheetId, sheetId, sheetName, keyColIndex1Based, validKeys) {

  const keyCol = columnLetter(keyColIndex1Based);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId,
    range: "'" + sheetName + "'!" + keyCol + '2:' + keyCol
  });

  const values = res.data.values || [];
  const rowsToDelete = [];

  values.forEach(function(row, i) {
    const key = row[0];
    if (key && !validKeys.has(String(key))) {
      rowsToDelete.push(i + 2);
    }
  });

  if (rowsToDelete.length === 0) {
    return 0;
  }

  rowsToDelete.sort(function(a, b) { return b - a; });

  const ranges = [];
  let rangeStart = rowsToDelete[0];
  let rangeEnd = rowsToDelete[0];

  for (let i = 1; i < rowsToDelete.length; i++) {
    const row = rowsToDelete[i];
    if (row === rangeEnd - 1) {
      rangeEnd = row;
    } else {
      ranges.push([rangeEnd, rangeStart]);
      rangeStart = row;
      rangeEnd = row;
    }
  }
  ranges.push([rangeEnd, rangeStart]);

  const requests = ranges.map(function(range) {
    return {
      deleteDimension: {
        range: {
          sheetId: sheetId,
          dimension: 'ROWS',
          startIndex: range[0] - 1,
          endIndex: range[1]
        }
      }
    };
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId,
    requestBody: { requests: requests }
  });

  return rowsToDelete.length;

}



// ใช้ร่วมกันโดย sync-tickets.js และ sync-trick2.js —
// อ่านคอลัมน์ id + repairResult จากชีทที่กำหนด คืน Set
// ของ id ที่ปิดงานแล้ว (เหมือน getClosedSubTicketIds_
// ใน trick.js เดิม)
async function getClosedIdsFromSheet(sheets, spreadsheetId, sheetName, idColIndex1Based, repairResultColIndex1Based, closedValue) {

  const closed = new Set();

  const idCol = columnLetter(idColIndex1Based);
  const repairCol = columnLetter(repairResultColIndex1Based);

  // เหมือน Apps Script เดิม (if (!sheet) return closed;)
  // — ถ้าชีทอ้างอิงยังไม่เคยถูกสร้าง (เช่น sync-trick2.js
  // รันก่อน sync-tickets.js ครั้งแรก) ให้คืน Set ว่างเปล่า
  // เงียบๆ แทนที่จะโยน error
  let idsRes;
  let repairRes;
  try {
    idsRes = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: "'" + sheetName + "'!" + idCol + '2:' + idCol
    });
    repairRes = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: "'" + sheetName + "'!" + repairCol + '2:' + repairCol
    });
  } catch (e) {
    return closed;
  }

  const ids = idsRes.data.values || [];
  const repairResults = repairRes.data.values || [];

  ids.forEach(function(row, i) {
    const id = row[0];
    const repairResult = repairResults[i] && repairResults[i][0];
    if (id && repairResult === closedValue) {
      closed.add(String(id));
    }
  });

  return closed;

}



module.exports = {
  getSheetsClient,
  columnLetter,
  getSheetIdByName,
  ensureSheetExists,
  ensureSheetAndBuildIndex,
  ensureGridSize,
  batchUpsert,
  getClosedIdsFromSheet,
  pruneStaleRows
};
