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
function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

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

  // เจอจริงว่าขยายเสร็จแล้ว แต่ values.batchUpdate ที่ยิง
  // ตามมาติดๆ ยัง error "exceeds grid limits" อยู่ — น่าจะ
  // เป็น eventual consistency ฝั่ง Google (metadata ใหม่
  // ยังไม่ propagate ทัน) เช็คย้ำ+รอสั้นๆ ก่อนไปต่อกันไว้
  for (let attempt = 0; attempt < 4; attempt++) {
    currentRows = await readGridRowCount(sheets, spreadsheetId, sheetId);
    if (requiredRows <= currentRows) {
      return;
    }
    await sleep(750);
  }

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



// replaceSheetData: เขียนทับทั้งชีทด้วยข้อมูลใหม่ที่จัดเรียงแล้ว (เหมาะสำหรับ daily snapshot sheet)
// 1. เขียน header แถวที่ 1
// 2. ล้างข้อมูลแถวที่ 2 เป็นต้นไป
// 3. เขียนแถวข้อมูลใหม่ทั้งหมดตั้งแต่แถว 2 ตามลำดับที่ส่งมา
async function replaceSheetData(sheets, spreadsheetId, sheetId, sheetName, headers, rows) {

  const lastCol = columnLetter(headers.length);

  // 1. เขียน header แถว 1
  await sheets.spreadsheets.values.update({
    spreadsheetId: spreadsheetId,
    range: "'" + sheetName + "'!A1:" + lastCol + '1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [headers] }
  });

  // 2. ล้างข้อมูลเก่าตั้งแต่แถว 2 ลงไป
  await sheets.spreadsheets.values.clear({
    spreadsheetId: spreadsheetId,
    range: "'" + sheetName + "'!A2:" + lastCol
  });

  // 3. ถ้ามีข้อมูลใหม่ ให้เขียนต่อตั้งแต่แถว 2
  if (rows.length > 0) {
    await ensureGridSize(sheets, spreadsheetId, sheetId, rows.length + 50);

    const values = rows.map(function(r) {
      return Array.isArray(r) ? r : (r.row || r);
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: spreadsheetId,
      range: "'" + sheetName + "'!A2:" + lastCol + (rows.length + 1),
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: values }
    });
  }

}



// replaceSheetDataWithSummary: เขียนทับทั้งชีทโดยมีแถว 1 เป็นแถบสรุป (ช่วงข้อมูล + จำนวนรายการ)
// แถว 2 เป็น header, แถว 3+ เป็นข้อมูลจริง พร้อม Merge, พื้นหลัง #fff2cc, ตัวหนา, และ Freeze 2 แถว
async function replaceSheetDataWithSummary(sheets, spreadsheetId, sheetId, sheetName, summaryText, headers, rows) {

  const lastCol = columnLetter(headers.length);

  // 1. ตรวจสอบและขยายขนาด grid
  const requiredRows = Math.max(rows.length + 50, 100);
  await ensureGridSize(sheets, spreadsheetId, sheetId, requiredRows);

  // 2. ล้างข้อมูลเก่าทั้งหมดตั้งแต่แถว 1 ลงไป
  await sheets.spreadsheets.values.clear({
    spreadsheetId: spreadsheetId,
    range: "'" + sheetName + "'!A1:" + lastCol
  });

  // 3. เขียนแถว 1 (ช่วงข้อมูล) และแถว 2 (หัวตาราง)
  const writeData = [
    {
      range: "'" + sheetName + "'!A1",
      values: [[summaryText]]
    },
    {
      range: "'" + sheetName + "'!A2:" + lastCol + '2',
      values: [headers]
    }
  ];

  // 4. เขียนแถวข้อมูลตั้งแต่แถว 3
  if (rows.length > 0) {
    const rowValues = rows.map(function(r) {
      return Array.isArray(r) ? r : (r.row || r);
    });
    writeData.push({
      range: "'" + sheetName + "'!A3:" + lastCol + (rows.length + 2),
      values: rowValues
    });
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: writeData
    }
  });

  // 5. จัด Format แถว 1 (Merge, สีพื้นหลัง #fff2cc, ตัวหนา, Freeze 2 แถวแรก)
  if (sheetId !== null && sheetId !== undefined) {
    try {
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: spreadsheetId,
          requestBody: {
            requests: [{
              unmergeCells: {
                range: {
                  sheetId: sheetId,
                  startRowIndex: 0,
                  endRowIndex: 1,
                  startColumnIndex: 0,
                  endColumnIndex: headers.length
                }
              }
            }]
          }
        });
      } catch (e) {
        // ignore unmerge error
      }

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
                  endColumnIndex: headers.length
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
                  endColumnIndex: headers.length
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



// อ่านคอลัมน์ id + คอลัมน์เป้าหมาย (เช่น Ticket No) จาก
// ชีทที่กำหนด คืน object id -> ค่านั้น — ใช้โดย sync-trick2.js
// เพื่อแปลง subId (ตัวเลขล้วนจาก checkrepair.php) เป็น
// Ticket No สำหรับ prune โดยไม่ต้อง fetch รายละเอียดตั๋ว
// ทุกใบซ้ำ (ใช้ของที่ sync-tickets.js เก็บไว้แล้วในชีท
// Tickets แทน)
async function getIdToValueMap(sheets, spreadsheetId, sheetName, idColIndex1Based, valueColIndex1Based) {

  const map = {};

  const idCol = columnLetter(idColIndex1Based);
  const valueCol = columnLetter(valueColIndex1Based);

  let idsRes;
  let valuesRes;
  try {
    idsRes = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: "'" + sheetName + "'!" + idCol + '2:' + idCol
    });
    valuesRes = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: "'" + sheetName + "'!" + valueCol + '2:' + valueCol
    });
  } catch (e) {
    return map;
  }

  const ids = idsRes.data.values || [];
  const values = valuesRes.data.values || [];

  ids.forEach(function(row, i) {
    const id = row[0];
    const value = values[i] && values[i][0];
    if (id && value) {
      map[String(id)] = String(value);
    }
  });

  return map;

}



module.exports = {
  getSheetsClient,
  columnLetter,
  getSheetIdByName,
  ensureSheetExists,
  ensureSheetAndBuildIndex,
  ensureGridSize,
  batchUpsert,
  replaceSheetData,
  replaceSheetDataWithSummary,
  getClosedIdsFromSheet,
  getIdToValueMap,
  pruneStaleRows
};
