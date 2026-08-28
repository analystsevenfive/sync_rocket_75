/*************************************************
 * ROCKET75 → GOOGLE SHEETS — "Trick2"
 *
 * ไฟล์นี้แยกจาก appscript.js โดยตั้งใจ (คนละ sheet,
 * คนละ Script Properties, รันอิสระจากกันได้) แต่ยัง
 * อยู่ใน Apps Script project เดียวกัน จึงใช้ฟังก์ชัน
 * ที่ประกาศไว้ใน appscript.js ได้ตรงๆ (global scope
 * เดียวกันทั้งโปรเจกต์): rocketLogin_, ROCKET,
 * getParentTicketHtml_, extractParentTicketIds_,
 * buildCheckRepairRequest_, extractCheckRepairIds_,
 * buildTicketDetailRequest_, parseTicketDetail_,
 * fetchAllWithRetry_, readJsonProp_, writeJsonProp_,
 * columnLetter_
 *
 * Mapping ที่ใช้:
 *   Received Date    <- reportDate (วันที่แจ้ง, จาก
 *                        parseTicketDetail_ ในไฟล์
 *                        appscript.js)
 *   Job No. (BK)     <- ticketNo (เลขที่ใบซ่อม เช่น
 *                        BKRM0826-000444.R01)
 *   Customer Name    <- customer (ลูกค้า)
 *   Technician Name  <- ช่าง จากตาราง "ตรวจเช็ค/
 *                        เข้าซ่อม" ของหน้า parent
 *                        (extractCheckRepairInfo_) —
 *                        ถ้ามีหลายคน join ด้วย ", "
 *                        ในเซลล์เดียว ไม่ duplicate
 *                        แถว เพราะ Job No. เป็น key
 *                        เทียบซ้ำของ batchUpsertTrick2_
 *                        ถ้าไม่เจอข้อมูล fallback ไปใช้
 *                        technician (ช่างเทคนิค) จาก
 *                        parseTicketDetail_ แทน
 *   Team             <- extractCheckRepairInfo_ เช่นกัน
 *                        (คอลัมน์ "การนัดหมาย" มีข้อความ
 *                        "ทีม : A (BK)")
 *   Remarks          <- note (หมายเหตุ)
 *   Rocket URL       <- url
 *
 * ยังไม่มีข้อมูลต้นทางที่ชัดเจนสำหรับ 2 คอลัมน์นี้
 * เลยปล่อยว่างไว้ก่อน (บอกทาง chat ว่าควรดึงจาก
 * ตรงไหน แล้วค่อยเติม): Work Order No., Total
 *************************************************/

const TRICK2_SHEET_NAME = 'Trick2';



/*************************************************
 * TEST INSPECT CHECKREPAIR TABLE STRUCTURE
 * (ใช้ครั้งเดียวเพื่อดู HTML จริงรอบๆ แต่ละแถวใน
 * ตาราง "ตรวจเช็ค/เข้าซ่อม" ของหน้า parent ticket —
 * ต้องดูโครงสร้างจริงก่อนเขียน regex ดึงคอลัมน์ "ช่าง"
 * (มีข้อความทีม เช่น "ทีม A (BK)" ต่อท้ายชื่อช่าง) มา
 * ใช้เป็นคอลัมน์ Team ของ Trick2)
 *************************************************/

function testInspectCheckRepairTeam() {

  const auth =
    rocketLogin_();


  const parentId =
    '7368650230';


  const html =
    getCheckRepair_(
      parentId,
      auth
    );


  Logger.log(
    'HTML length: ' +
    html.length
  );


  // HTML ก้อนนี้เล็กมาก (ไม่กี่พันตัวอักษร) log เต็ม
  // ไปเลยดีกว่าตัดหน้าต่างแล้วพลาดจุดที่ต้องการ
  Logger.log(
    'FULL HTML:\n' +
    html
      .replace(/></g, '>\n<')
  );


  Logger.log(
    'INFO MAP: ' +
    JSON.stringify(
      extractCheckRepairInfo_(html)
    )
  );

}



/*************************************************
 * EXTRACT TEAM + TECHNICIAN(S) PER SUB TICKET
 * (จากตาราง "ตรวจเช็ค/เข้าซ่อม" ของหน้า parent —
 * แต่ละแถว <tr id="tr_{subTicketId}"> — ดูจาก
 * testInspectCheckRepairTeam() log จริง:
 *   คอลัมน์ที่ 2 (การนัดหมาย) มีข้อความ
 *     "ทีม : A (BK)" ระบุทีมไว้ชัดเจน
 *   คอลัมน์ที่ 3 (ช่าง) มีชื่อช่าง — บาง ticket มี
 *     มากกว่า 1 คน คั่นด้วย <br> ต่อบรรทัด แต่ละ
 *     บรรทัดเป็น "ชื่อช่าง ทีม ... " เอาแค่ส่วนก่อน
 *     คำว่า "ทีม" มาเป็นชื่อ แล้ว join ด้วย ", "
 *     เก็บไว้ในเซลล์เดียว (ไม่ duplicate แถว เพราะ
 *     batchUpsertTrick2_ ใช้ Job No. (BK) เป็น key
 *     ไม่ซ้ำต่อ ticket — duplicate แถวจะทำให้ upsert
 *     ทับกันเองและนับ Total ซ้ำถ้ามีคอลัมน์รวมยอด)
 *************************************************/

function extractCheckRepairInfo_(html) {

  const info = {};

  const rowRegex =
    /<tr\s+id=["']tr_(\d+)["'][^>]*>([\s\S]*?)<\/tr>/gi;

  let rowMatch;


  while (
    (rowMatch = rowRegex.exec(html))
    !== null
  ) {

    const subId =
      rowMatch[1];

    const rowHtml =
      rowMatch[2];


    const cellRegex =
      /<td[^>]*>([\s\S]*?)<\/td>/gi;

    const cells = [];

    let cellMatch;


    while (
      (cellMatch = cellRegex.exec(rowHtml))
      !== null
    ) {

      cells.push(
        cellMatch[1]
      );

    }


    const appointmentCell =
      cells[1] ||
      '';

    const technicianCell =
      cells[2] ||
      '';


    const teamMatch =
      appointmentCell.match(
        /ทีม\s*:\s*([\s\S]*?)<br/i
      );


    const technicians =
      technicianCell
        .split(/<br\s*\/?>/i)
        .map(function(line) {

          const cleaned =
            cleanText_(line);

          const teamWordIdx =
            cleaned.indexOf('ทีม');

          return teamWordIdx >= 0
            ? cleaned
                .substring(0, teamWordIdx)
                .trim()
            : cleaned;

        })
        .filter(function(name) {

          return name !== '';

        });


    info[subId] = {

      team:
        teamMatch
          ? cleanText_(teamMatch[1])
          : '',

      technicians:
        technicians.join(', ')

    };

  }


  return info;

}



/*************************************************
 * MAIN
 *************************************************/

function syncTrick2() {

  const startedAt =
    new Date();

  const maxRunMs =
    4.5 * 60 * 1000;

  function timeLeftMs_() {

    return (
      maxRunMs -
      (new Date() - startedAt)
    );

  }


  Logger.log(
    '========== TRICK2 SYNC =========='
  );


  const auth =
    rocketLogin_();

  Logger.log(
    'LOGIN OK'
  );


  const props =
    PropertiesService
      .getScriptProperties();


  // ==========================================
  // 1. GET PARENT TICKETS
  // ==========================================

  let parentIds =
    readJsonProp_(
      props,
      'SYNC2_PARENT_IDS'
    );


  if (parentIds === null) {

    // เริ่ม sync cycle ใหม่ (ไม่ใช่ resume ต่อ) — ไม่
    // clear ทั้งชีทแล้วเหมือนเดิม เปลี่ยนเป็น upsert
    // ล้วนๆ + ข้าม ticket ที่ปิดงานแล้วตอน phase 3 (ดู
    // getClosedSubTicketIds_ ในไฟล์ trick.js) เพราะ
    // ข้อมูล 3 เดือนมีจำนวนมาก resync ทุกใบทุกรอบช้าเกิน
    const parentHtml =
      getParentTicketHtml_(
        auth,
        ROCKET.START_DATE,
        ROCKET.END_DATE
      );

    parentIds =
      extractParentTicketIds_(
        parentHtml
      );

    writeJsonProp_(
      props,
      'SYNC2_PARENT_IDS',
      parentIds
    );

    Logger.log(
      'PARENT TICKETS: ' +
      parentIds.length
    );

  } else {

    Logger.log(
      'PARENT TICKETS (จากรอบก่อน): ' +
      parentIds.length
    );

  }


  // ==========================================
  // 2. GET SUB TICKETS แบบยิงขนาน (fetchAll)
  // ==========================================

  let pendingParents =
    readJsonProp_(
      props,
      'SYNC2_PENDING_PARENTS'
    );

  if (pendingParents === null) {

    pendingParents =
      parentIds.slice();

  }


  let subIds =
    readJsonProp_(
      props,
      'SYNC2_SUB_IDS'
    ) ||
    [];

  let infoMap =
    readJsonProp_(
      props,
      'SYNC2_INFO_MAP'
    ) ||
    {};


  // 20 → 35 → 100 (เหตุผลเดียวกับ trick.js —
  // ถอยกลับมา 35 ถ้า error rate สูงขึ้น)
  const PARENT_CHUNK =
    100;


  while (
    pendingParents.length > 0 &&
    timeLeftMs_() > 20000
  ) {

    const batch =
      pendingParents.slice(
        0,
        PARENT_CHUNK
      );

    const requests =
      batch.map(function(parentId) {

        return buildCheckRepairRequest_(
          parentId,
          auth
        );

      });

    const responses =
      fetchAllWithRetry_(
        requests,
        3
      );

    responses.forEach(function(res, i) {

      const parentId =
        batch[i];

      try {

        if (
          res.getResponseCode()
          !== 200
        ) {

          throw new Error(
            res._error ||
            ('HTTP ' + res.getResponseCode())
          );

        }

        const text =
          res.getContentText('UTF-8');

        const ids =
          extractCheckRepairIds_(
            text
          );

        subIds =
          subIds.concat(ids);

        Object.assign(
          infoMap,
          extractCheckRepairInfo_(
            text
          )
        );

      } catch (e) {

        Logger.log(
          'ERROR Parent ' +
          parentId +
          ': ' +
          e.message
        );

      }

    });

    subIds =
      [...new Set(subIds)];

    pendingParents =
      pendingParents.slice(
        PARENT_CHUNK
      );

    writeJsonProp_(
      props,
      'SYNC2_PENDING_PARENTS',
      pendingParents
    );

    writeJsonProp_(
      props,
      'SYNC2_SUB_IDS',
      subIds
    );

    writeJsonProp_(
      props,
      'SYNC2_INFO_MAP',
      infoMap
    );

    Logger.log(
      'Sub ticket ids: ' +
      subIds.length +
      ' (เหลือ parent อีก ' +
      pendingParents.length +
      ')'
    );

  }


  if (pendingParents.length > 0) {

    Logger.log(
      'ใกล้ timeout — เหลือ parent อีก ' +
      pendingParents.length +
      ' ตัว กด "เรียกใช้" syncTrick2 ซ้ำเพื่อทำต่อ'
    );

    return;

  }


  Logger.log(
    'SUB TICKETS: ' +
    subIds.length
  );


  // ==========================================
  // 3. GET DETAIL แบบยิงขนาน + เขียนชีทเป็น batch
  // ==========================================

  let pendingSubs =
    readJsonProp_(
      props,
      'SYNC2_PENDING_SUBS'
    );

  let totalToFetch =
    readJsonProp_(
      props,
      'SYNC2_TOTAL_TO_FETCH'
    );


  if (pendingSubs === null) {

    // อ้างอิงชีท Tickets (getClosedSubTicketIds_ จาก
    // trick.js) เพื่อข้าม ticket ที่ปิดงานแล้ว ไม่ fetch
    // detail ซ้ำ — ถ้า syncRocket75 ยังไม่เคยรัน/ยังไม่มี
    // ข้อมูล Repair Result ของ id นี้ จะไม่ข้ามอะไรเลย
    // (fetch ตามปกติ ปลอดภัยกว่าเดาข้ามผิด)
    const closedIds =
      getClosedSubTicketIds_();

    pendingSubs =
      subIds.filter(function(id) {

        return !closedIds.has(
          String(id)
        );

      });

    totalToFetch =
      pendingSubs.length;

    writeJsonProp_(
      props,
      'SYNC2_TOTAL_TO_FETCH',
      totalToFetch
    );

    const skippedCount =
      subIds.length -
      pendingSubs.length;

    if (skippedCount > 0) {

      Logger.log(
        'ข้าม ' +
        skippedCount +
        ' ใบเพราะปิดงานแล้ว (อ้างอิงจากชีท Tickets) — ' +
        'เหลือต้อง fetch ' +
        pendingSubs.length +
        ' ใบ จากทั้งหมด ' +
        subIds.length +
        ' ใบ'
      );

    }

  }

  if (totalToFetch === null) {

    totalToFetch =
      subIds.length;

  }


  const trick2Ctx =
    buildTrick2RowIndex_();

  // 15 → 30 → 100 (เหตุผลเดียวกับ trick.js —
  // ถอยกลับมา 30 ถ้า error rate สูงขึ้น)
  const SUB_CHUNK =
    100;


  while (
    pendingSubs.length > 0 &&
    timeLeftMs_() > 20000
  ) {

    const batch =
      pendingSubs.slice(
        0,
        SUB_CHUNK
      );

    const requests =
      batch.map(function(subId) {

        return buildTicketDetailRequest_(
          subId,
          auth
        );

      });

    const responses =
      fetchAllWithRetry_(
        requests,
        3
      );

    const ticketsToWrite = [];


    responses.forEach(function(res, i) {

      const subId =
        batch[i];

      try {

        if (
          res.getResponseCode()
          !== 200
        ) {

          throw new Error(
            res._error ||
            ('HTTP ' + res.getResponseCode())
          );

        }

        const html =
          res.getContentText('UTF-8');

        const ticket =
          parseTicketDetail_(
            html,
            subId
          );

        const info =
          infoMap[String(subId)] ||
          {};

        ticket.team =
          info.team ||
          '';

        ticket.technicians =
          info.technicians ||
          ticket.technician ||
          '';

        ticketsToWrite.push(ticket);

      } catch (e) {

        Logger.log(
          'ERROR SubTicket ' +
          subId +
          ': ' +
          e.message
        );

      }

    });

    batchUpsertTrick2_(
      ticketsToWrite,
      trick2Ctx
    );

    pendingSubs =
      pendingSubs.slice(
        SUB_CHUNK
      );

    writeJsonProp_(
      props,
      'SYNC2_PENDING_SUBS',
      pendingSubs
    );

    Logger.log(
      'เขียนแล้ว ' +
      (totalToFetch - pendingSubs.length) +
      '/' +
      totalToFetch
    );

  }


  if (pendingSubs.length > 0) {

    Logger.log(
      'ใกล้ timeout — เหลือ ticket อีก ' +
      pendingSubs.length +
      ' ตัว กด "เรียกใช้" syncTrick2 ซ้ำเพื่อทำต่อ'
    );

    return;

  }


  props.deleteProperty('SYNC2_PARENT_IDS');
  props.deleteProperty('SYNC2_PENDING_PARENTS');
  props.deleteProperty('SYNC2_SUB_IDS');
  props.deleteProperty('SYNC2_PENDING_SUBS');
  props.deleteProperty('SYNC2_INFO_MAP');
  props.deleteProperty('SYNC2_TOTAL_TO_FETCH');


  const seconds =
    Math.round(
      (new Date() - startedAt) / 1000
    );


  Logger.log(
    'DONE: ' +
    seconds +
    ' sec'
  );

}



/*************************************************
 * RESET / CLEAR
 * (แยกชุด property กับ sheet คนละอันจาก
 * syncRocket75 ในไฟล์ appscript.js โดยตั้งใจ —
 * resetSync2State() ล้างแค่ progress ไม่กระทบข้อมูล
 * ในชีท, clearTrick2SheetData() ลบข้อมูลจริงถาวร)
 *************************************************/

function resetSync2State() {

  const props =
    PropertiesService
      .getScriptProperties();


  props.deleteProperty('SYNC2_PARENT_IDS');
  props.deleteProperty('SYNC2_PENDING_PARENTS');
  props.deleteProperty('SYNC2_SUB_IDS');
  props.deleteProperty('SYNC2_PENDING_SUBS');
  props.deleteProperty('SYNC2_INFO_MAP');
  props.deleteProperty('SYNC2_TOTAL_TO_FETCH');


  Logger.log(
    'ล้าง sync state ของ Trick2 แล้ว ' +
    'รัน syncTrick2 รอบถัดไปจะเริ่มนับ parent/sub ' +
    'ticket ใหม่ทั้งหมด (ข้อมูลในชีท Trick2 ' +
    'ที่เขียนไปแล้วยังอยู่ครบ ไม่ถูกลบ)'
  );

}



// ไม่ถูกเรียกอัตโนมัติจาก syncTrick2() แล้ว — เก็บไว้
// ใช้แบบ manual เท่านั้น (sync ใช้ upsert ล้วนๆ แทน)
function clearTrick2SheetData() {

  const ss =
    SpreadsheetApp
      .getActiveSpreadsheet();

  const sheet =
    ss.getSheetByName(
      TRICK2_SHEET_NAME
    );

  if (!sheet) {

    return;

  }


  const lastRow =
    sheet.getLastRow();

  const lastCol =
    sheet.getLastColumn();


  if (lastRow >= 2) {

    sheet.getRange(
      2,
      1,
      lastRow - 1,
      lastCol
    ).clearContent();

  }


  Logger.log(
    'ล้างข้อมูลชีท "' +
    TRICK2_SHEET_NAME +
    '" แล้ว (เหลือแค่ header) — ถ้าจะ sync ใหม่ ' +
    'ทั้งหมดให้รัน resetSync2State() ด้วย ก่อนรัน syncTrick2'
  );

}



/*************************************************
 * WRITE TRICK2 SHEET
 *************************************************/

const TRICK2_HEADERS_ = [

  'Received Date',
  'Work Order No.',
  'Job No. (BK)',
  'Customer Name',
  'Technician Name',
  'Team',
  'Total',
  'Remarks',
  'Rocket URL',
  'Last Sync'

];



function trick2ToRow_(d) {

  return [

    d.reportDate,
    '',
    d.ticketNo,
    d.customer,
    d.technicians,
    d.team,
    '',
    d.note,
    d.url,

    formatDateForSheet_(
      d.lastSync
    )

  ];

}



function buildTrick2RowIndex_() {

  const ss =
    SpreadsheetApp
      .getActiveSpreadsheet();


  let sheet =
    ss.getSheetByName(
      TRICK2_SHEET_NAME
    );


  if (!sheet) {

    sheet =
      ss.insertSheet(
        TRICK2_SHEET_NAME
      );

  }


  sheet.getRange(
    1,
    1,
    1,
    TRICK2_HEADERS_.length
  ).setValues(
    [TRICK2_HEADERS_]
  );


  // ใช้คอลัมน์ C (Job No. (BK)) เป็น key เทียบซ้ำ
  // เพราะ Trick2 ไม่มีคอลัมน์ Ticket ID ตรงๆ เหมือน
  // ชีท Tickets — ticketNo (เลขที่ใบซ่อม) ไม่ซ้ำกัน
  const index = {};

  const lastRow =
    sheet.getLastRow();


  if (lastRow >= 2) {

    const jobNos =
      sheet.getRange(
        2,
        3,
        lastRow - 1,
        1
      )
      .getDisplayValues();

    jobNos.forEach(function(row, i) {

      index[String(row[0])] =
        i + 2;

    });

  }


  return {

    sheet: sheet,
    index: index,
    lastRow: lastRow

  };

}



function batchUpsertTrick2_(
  tickets,
  ctx
) {

  if (tickets.length === 0) {

    return;

  }


  const spreadsheetId =
    SpreadsheetApp
      .getActiveSpreadsheet()
      .getId();

  const sheetName =
    ctx.sheet.getName();

  const lastCol =
    columnLetter_(
      TRICK2_HEADERS_.length
    );

  const data = [];

  const newRows = [];


  tickets.forEach(function(d) {

    const row =
      trick2ToRow_(d);

    const existingRow =
      ctx.index[String(d.ticketNo)];


    if (existingRow) {

      data.push({

        range:
          "'" + sheetName + "'!A" +
          existingRow + ':' +
          lastCol + existingRow,

        values: [row]

      });

    } else {

      newRows.push({

        ticketNo: d.ticketNo,
        row: row

      });

    }

  });


  if (newRows.length > 0) {

    const startRow =
      ctx.lastRow + 1;

    data.push({

      range:
        "'" + sheetName + "'!A" +
        startRow + ':' +
        lastCol + (startRow + newRows.length - 1),

      values:
        newRows.map(function(r) {

          return r.row;

        })

    });

    newRows.forEach(function(r, i) {

      ctx.index[String(r.ticketNo)] =
        startRow + i;

    });

    ctx.lastRow +=
      newRows.length;

  }


  Sheets.Spreadsheets.Values.batchUpdate(
    {

      valueInputOption:
        'USER_ENTERED',

      data: data

    },
    spreadsheetId
  );

}
