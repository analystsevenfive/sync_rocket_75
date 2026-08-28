/*************************************************
 * ROCKET75 → GOOGLE SHEETS — "รายงานภาพรวม" INSPECT
 * (ยังไม่เขียน sync จริง — แค่ inspect ก่อนว่าปุ่ม
 * "รายงาน" ในหน้า report_ticket.php ยิงไปที่ไหน
 * ถ้าเป็น bulk export แบบเดียวกับ gasoline.js
 * (export_cost_all.php ที่คืนไฟล์เดียวมาให้เลย) จะ
 * เปลี่ยนสถาปัตยกรรม syncRocket75/syncTrick2 จาก
 * "2,400+ request ทีละ ticket" เหลือ "1 request"
 * ได้เลย เร็วขึ้นแบบก้าวกระโดด — ผู้ใช้ส่งสกรีนช็อต
 * หน้านี้มาให้ดู มี filter: สถานะ, สาขา, ทีม, ช่าง,
 * ยี่ห้อ, รุ่น, ช่วงวันที่, ค้นหา + ปุ่ม "รายงาน"
 *************************************************/

function testInspectTicketReportPage() {

  const auth =
    rocketLogin_();


  const url =
    ROCKET.BASE +
    '/main/report_ticket.php';


  const headers = {};

  if (auth.cookie) {

    headers.Cookie =
      auth.cookie;

  }


  const res =
    UrlFetchApp.fetch(
      url,
      {

        method: 'get',

        headers: headers,

        muteHttpExceptions: true

      }
    );


  Logger.log(
    'HTTP ' +
    res.getResponseCode()
  );


  const html =
    res.getContentText('UTF-8');

  Logger.log(
    'HTML length: ' +
    html.length
  );


  // ==========================================
  // 1. หา endpoint ที่ขึ้นต้นด้วย ajax/report_ticket
  // (รูปแบบเดียวกับที่ gasoline.js ใช้:
  // ajax/report_ticket/gasoline/export_cost_all.php)
  // ==========================================

  const endpointRegex =
    /ajax\/report_ticket\/[^"'\s)\\]+/g;

  const endpoints =
    new Set();

  let m;


  while (
    (m = endpointRegex.exec(html))
    !== null
  ) {

    endpoints.add(m[0]);

  }


  if (endpoints.size > 0) {

    Logger.log(
      'พบ endpoint ที่ขึ้นต้นด้วย ajax/report_ticket:\n' +
      Array.from(endpoints).join('\n')
    );

  } else {

    Logger.log(
      'ไม่เจอ endpoint แบบ ajax/report_ticket/... ' +
      'ในหน้านี้เลย — อาจยิงแบบอื่น หรือโหลดผ่าน JS ' +
      'บันเดิลแยกไฟล์ (ดูข้อ 2-3 ด้านล่างเพิ่ม)'
    );

  }


  // ==========================================
  // 2. หา <form> ที่เกี่ยวกับรายงาน (action/id/name)
  // ==========================================

  const formRegex =
    /<form\b[^>]*>/gi;

  let formMatch;

  let formCount = 0;


  while (
    (formMatch = formRegex.exec(html))
    !== null &&
    formCount < 10
  ) {

    Logger.log(
      'FORM #' +
      (formCount + 1) +
      ': ' +
      formMatch[0]
    );

    formCount++;

  }


  // ==========================================
  // 3. หาปุ่ม/โค้ดรอบๆ คำว่า "รายงาน" (ปุ่มสีเขียว
  // ในสกรีนช็อต) — ดู onclick/id เผื่อเรียก JS
  // function ที่ยิง ajax เอง
  // ==========================================

  const btnAnchor =
    html.lastIndexOf(
      '>รายงาน<'
    );


  if (btnAnchor !== -1) {

    const start =
      Math.max(
        0,
        btnAnchor - 600
      );

    const end =
      Math.min(
        html.length,
        btnAnchor + 200
      );

    Logger.log(
      'AROUND ปุ่ม "รายงาน":\n' +
      html
        .substring(start, end)
        .replace(/></g, '>\n<')
    );

  } else {

    Logger.log(
      'ไม่เจอข้อความ ">รายงาน<" ตรงๆ ในหน้านี้ ' +
      '(อาจอยู่ใน <button>รายงาน</button> รูปแบบอื่น)'
    );

  }


  // ==========================================
  // 4. หา .php ทั้งหมดที่ปรากฏใน <script> ของหน้านี้
  // (กวาดกว้างๆ ไว้เผื่อ endpoint ไม่ได้ขึ้นต้นด้วย
  // ajax/report_ticket ตามที่เดาไว้)
  // ==========================================

  const scriptRegex =
    /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

  const phpRefs =
    new Set();

  let scriptMatch;


  while (
    (scriptMatch = scriptRegex.exec(html))
    !== null
  ) {

    const scriptBody =
      scriptMatch[1];

    const phpRegex =
      /["']([^"']*\.php[^"']*)["']/g;

    let phpMatch;


    while (
      (phpMatch = phpRegex.exec(scriptBody))
      !== null
    ) {

      phpRefs.add(
        phpMatch[1]
      );

    }

  }


  Logger.log(
    '.php ทั้งหมดที่เจอใน <script> ของหน้านี้ (' +
    phpRefs.size +
    ' รายการ):\n' +
    Array.from(phpRefs).join('\n')
  );

}



/*************************************************
 * ทดสอบ export endpoint ที่เจอจาก testInspectTicketReportPage()
 * (field name ยืนยันแล้วจาก DevTools Payload จริงตอน
 * กดปุ่ม "รายงาน" ด้วยตัวกรอง "ทั้งหมด" ทุกช่อง:
 *   status=&start_date=...&end_date=...&search_team=x
 *   &search_staff=x&area_select_main=x&sub_status=undefined
 *   &brand_id=&model_id=&search_type=x&name_search=
 * สังเกต: status/brand_id/model_id/name_search ว่างเปล่า
 * (ไม่ใช่ 'x') ส่วน search_team/search_staff/
 * area_select_main/search_type ใช้ 'x' แทน "ทั้งหมด"
 * sub_status ส่งเป็น string "undefined" ตรงตัว (ดูเหมือน
 * บั๊กฝั่ง JS ของเว็บเอง แต่ปล่อยตามนั้นเพื่อ mimic
 * request ที่ใช้งานได้จริง) — ไม่มี token/key ในสิ่งที่
 * capture มา (อาจเพราะฝั่ง browser ใช้ session cookie
 * แทน) แนบไปด้วยเผื่อไว้เหมือน endpoint อื่นๆ ถ้า
 * ไม่ได้ใช้ server จะเพิกเฉยไปเอง ไม่เสียหาย
 *************************************************/

function buildTicketOverallExportRequest_(
  auth,
  startDate,
  endDate,
  endpoint
) {

  const headers = {

    Origin:
      ROCKET.BASE,

    Referer:
      ROCKET.BASE +
      '/main/report_ticket.php',

    'X-Requested-With':
      'XMLHttpRequest'

  };


  if (auth.cookie) {

    headers.Cookie =
      auth.cookie;

  }


  return {

    url:
      ROCKET.BASE +
      '/main/' +
      endpoint,

    method:
      'post',

    payload: {

      status:
        '',

      start_date:
        startDate,

      end_date:
        endDate,

      search_team:
        'x',

      search_staff:
        'x',

      area_select_main:
        'x',

      sub_status:
        'undefined',

      brand_id:
        '',

      model_id:
        '',

      search_type:
        'x',

      name_search:
        '',

      token:
        auth.token,

      key:
        auth.key

    },

    headers:
      headers,

    muteHttpExceptions:
      true

  };

}



function testTicketOverallExport() {

  const auth =
    rocketLogin_();


  const endpoints = [

    'ajax/report_ticket/overall/export_overall_new.php',
    'ajax/report_ticket/overall/export_overall.php'

  ];


  endpoints.forEach(function(endpoint) {

    Logger.log(
      '========== ' +
      endpoint +
      ' =========='
    );


    const request =
      buildTicketOverallExportRequest_(
        auth,
        ROCKET.START_DATE,
        ROCKET.END_DATE,
        endpoint
      );

    const res =
      UrlFetchApp.fetch(
        request.url,
        request
      );


    Logger.log(
      'HTTP ' +
      res.getResponseCode()
    );

    Logger.log(
      'Content-Type: ' +
      res.getHeaders()['Content-Type']
    );


    const blob =
      res.getBlob();

    Logger.log(
      'Blob size: ' +
      blob.getBytes().length +
      ' bytes'
    );


    const zipBlob =
      blob.setContentType(
        'application/zip'
      );


    try {

      const files =
        Utilities.unzip(zipBlob);

      files.forEach(function(f) {

        Logger.log(
          'FILE: ' +
          f.getName() +
          ' (' +
          f.getBytes().length +
          ' bytes)'
        );

      });

    } catch (e) {

      Logger.log(
        'ไม่ใช่ zip/xlsx: ' +
        e.message +
        ' — log 800 ตัวแรกแทน (เช็คว่า server บอก field ' +
        'ไหนขาด/ผิดไหม):\n' +
        blob.getDataAsString('UTF-8').substring(0, 800)
      );

    }

  });

}



/*************************************************
 * ดูเนื้อหาจริงข้างใน export_overall_new.php
 * (ไฟล์เล็กมาก ~6KB sheet1.xml เทียบกับ gasoline ที่
 * ~8-20KB สำหรับข้อมูลไม่กี่สิบแถว — สงสัยว่าเป็น
 * รายงานสรุปนับจำนวน (เช่นนับตามสถานะ) ไม่ใช่รายชื่อ
 * ticket ทีละใบแบบที่ต้องการ ต้องดูโครงสร้างจริงก่อน)
 *************************************************/

function testInspectTicketOverallXlsx() {

  const auth =
    rocketLogin_();


  const request =
    buildTicketOverallExportRequest_(
      auth,
      ROCKET.START_DATE,
      ROCKET.END_DATE,
      'ajax/report_ticket/overall/export_overall_new.php'
    );

  const res =
    UrlFetchApp.fetch(
      request.url,
      request
    );


  const blob =
    res.getBlob()
      .setContentType('application/zip');


  const files =
    Utilities.unzip(blob);


  const sheet1 =
    files.filter(function(f) {

      return (
        f.getName() ===
        'xl/worksheets/sheet1.xml'
      );

    })[0];

  const shared =
    files.filter(function(f) {

      return (
        f.getName() ===
        'xl/sharedStrings.xml'
      );

    })[0];


  if (shared) {

    Logger.log(
      'SHARED STRINGS XML:\n' +
      shared
        .getDataAsString('UTF-8')
    );

  }


  if (sheet1) {

    Logger.log(
      'SHEET1 XML:\n' +
      sheet1
        .getDataAsString('UTF-8')
        .replace(/></g, '>\n<')
    );

  }

}



/*************************************************
 * PARSE รายงานภาพรวม เป็น object อ่านง่าย
 * (ยืนยันจาก log จริงแล้วว่ามีข้อมูลราย ticket ครบ
 * 1,552 แถว/3 เดือน — ใช้ parseSharedStrings_/
 * parseSheetRows_ จาก gasoline.js ตัวเดิม ไม่ต้อง
 * เขียน XML parser ใหม่ (global scope เดียวกัน)
 * ลำดับคอลัมน์ A-AK ยืนยันจาก sharedStrings ที่ log มา
 *************************************************/

const TICKET_OVERALL_HEADER_MAP_ = [

  'ประเภทงาน',
  'วันที่แจ้งซ่อม',
  'Ticket',
  'รหัสลูกค้า',
  'ชื่อลูกค้า',
  'สาขาลูกค้า',
  'ยี่ห้อสินค้า',
  'รุ่นสินค้า',
  'ชื่อสินค้า',
  'S/N',
  'อาการเสีย',
  'วันที่หมดประกัน',
  'สถานะประกัน',
  'Check In Date',
  'Check Out Date',
  'ชื่อ',
  'นามสกุล',
  'รหัสพนักงาน',
  'จำนวนเข้าต่อเนื่อง',
  'จำนวนงานจบ',
  'จำนวนงานไม่จบ',
  '24 hr',
  '48 hr',
  '72 hr',
  'over 72 hr',
  'สถานะใบเสนอราคา',
  'สถานะงาน',
  'จำนวนเงินรอเปิดบิล',
  'จำนวนเงินเปิดบิลแล้ว',
  'comment',
  'complain',
  'เวลาทั้งหมด',
  'การใช้รถยนต์',
  'ไมล์ล่าสุด',
  'หัวข้อค่าน้ำมัน',
  'หมายเหตุค่าน้ำมัน',
  'บันทึกประจำวัน'

];



const TICKET_OVERALL_COLUMNS_ =

  'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    .split('')
    .concat([

      'AA', 'AB', 'AC', 'AD',
      'AE', 'AF', 'AG', 'AH',
      'AI', 'AJ', 'AK'

    ]);



function testParseTicketOverallReport() {

  const auth =
    rocketLogin_();


  const request =
    buildTicketOverallExportRequest_(
      auth,
      ROCKET.START_DATE,
      ROCKET.END_DATE,
      'ajax/report_ticket/overall/export_overall_new.php'
    );

  const res =
    UrlFetchApp.fetch(
      request.url,
      request
    );


  const blob =
    res.getBlob()
      .setContentType('application/zip');

  const files =
    Utilities.unzip(blob);


  const sheetFile =
    files.filter(function(f) {

      return (
        f.getName() ===
        'xl/worksheets/sheet1.xml'
      );

    })[0];

  const sharedFile =
    files.filter(function(f) {

      return (
        f.getName() ===
        'xl/sharedStrings.xml'
      );

    })[0];


  const sharedStrings =
    sharedFile
      ? parseSharedStrings_(
          sharedFile.getDataAsString('UTF-8')
        )
      : [];

  const rows =
    parseSheetRows_(
      sheetFile.getDataAsString('UTF-8'),
      sharedStrings
    );


  const rowNumbers =
    Object.keys(rows)
      .map(Number)
      .sort(function(a, b) {

        return a - b;

      });


  Logger.log(
    'จำนวนแถวทั้งหมด (รวม header): ' +
    rowNumbers.length
  );

  Logger.log(
    'จำนวนแถวข้อมูล (ไม่รวม header): ' +
    (rowNumbers.length - 1)
  );


  rowNumbers
    .slice(1, 4)
    .forEach(function(rowNum) {

      const cells =
        rows[rowNum];

      const obj = {};


      TICKET_OVERALL_COLUMNS_
        .forEach(function(col, i) {

          obj[TICKET_OVERALL_HEADER_MAP_[i]] =
            cells[col] !== undefined
              ? cells[col]
              : '';

        });


      Logger.log(
        'ROW ' +
        rowNum +
        ':\n' +
        JSON.stringify(obj, null, 2)
      );

    });

}



/*************************************************
 * SYNC ทดสอบ — เขียน Overall Report ทั้งก้อนลงชีท
 * ทดสอบแยกต่างหาก (ไม่แตะ Tickets/Trick2/Gasoline
 * ของจริงเลย) เพื่อเทียบข้อมูลกับหน้าเว็บจริงให้มั่นใจ
 * ก่อนค่อยเอาไปแทนที่ syncTrick2()/syncGasoline() จริง
 *
 * เป็น snapshot เดียวจบ (เหมือน syncGasoline ไม่ใช่
 * resumable แบบ syncRocket75) เพราะ export มาทีเดียว
 * ทั้งก้อนอยู่แล้ว ไม่ต้อง chunk — ค่าทุกคอลัมน์เขียน
 * เป็น text ตรงๆ ตามที่ parse ได้ ยังไม่แปลงชนิดข้อมูล
 * (ตัวเลข/วันที่) เพราะเป้าหมายตอนนี้คือเช็คความถูกต้อง
 * ของข้อมูลก่อน ไม่ใช่ final schema
 *************************************************/

const OVERALL_REPORT_TEST_SHEET_NAME_ =
  'Overall Report (Test)';



function extractOverallReportRows_(blob) {

  const zipBlob =
    blob.setContentType(
      'application/zip'
    );

  const files =
    Utilities.unzip(zipBlob);


  const sheetFile =
    files.filter(function(f) {

      return (
        f.getName() ===
        'xl/worksheets/sheet1.xml'
      );

    })[0];

  const sharedFile =
    files.filter(function(f) {

      return (
        f.getName() ===
        'xl/sharedStrings.xml'
      );

    })[0];


  const sharedStrings =
    sharedFile
      ? parseSharedStrings_(
          sharedFile.getDataAsString('UTF-8')
        )
      : [];

  const rows =
    parseSheetRows_(
      sheetFile.getDataAsString('UTF-8'),
      sharedStrings
    );


  const rowNumbers =
    Object.keys(rows)
      .map(Number)
      .sort(function(a, b) {

        return a - b;

      });


  // แถวแรก (rowNumbers[0]) เป็น header อยู่แล้ว
  // (ตรงกับ TICKET_OVERALL_HEADER_MAP_) ข้ามไป
  return rowNumbers
    .slice(1)
    .map(function(rowNum) {

      const cells =
        rows[rowNum];

      return TICKET_OVERALL_COLUMNS_
        .map(function(col) {

          return cells[col] !== undefined
            ? cells[col]
            : '';

        });

    });

}



function writeOverallReportTestSheet_(dataRows) {

  const ss =
    SpreadsheetApp
      .getActiveSpreadsheet();


  let sheet =
    ss.getSheetByName(
      OVERALL_REPORT_TEST_SHEET_NAME_
    );

  if (!sheet) {

    sheet =
      ss.insertSheet(
        OVERALL_REPORT_TEST_SHEET_NAME_
      );

  }


  sheet.clearContents();


  const lastSync =
    formatDateForSheet_(
      new Date()
    );

  const headers =
    TICKET_OVERALL_HEADER_MAP_.concat([
      'Last Sync'
    ]);

  const rowsWithLastSync =
    dataRows.map(function(row) {

      return row.concat([
        lastSync
      ]);

    });

  const values =
    [headers].concat(
      rowsWithLastSync
    );


  sheet.getRange(
    1,
    1,
    values.length,
    headers.length
  ).setValues(
    values
  );

}



function syncOverallReportTest() {

  Logger.log(
    '========== OVERALL REPORT SYNC (TEST) =========='
  );


  const auth =
    rocketLogin_();

  Logger.log(
    'LOGIN OK'
  );


  const request =
    buildTicketOverallExportRequest_(
      auth,
      ROCKET.START_DATE,
      ROCKET.END_DATE,
      'ajax/report_ticket/overall/export_overall_new.php'
    );

  const res =
    UrlFetchApp.fetch(
      request.url,
      request
    );


  if (
    res.getResponseCode()
    !== 200
  ) {

    throw new Error(
      'Overall report export HTTP ' +
      res.getResponseCode()
    );

  }


  const dataRows =
    extractOverallReportRows_(
      res.getBlob()
    );

  Logger.log(
    'พบข้อมูล ' +
    dataRows.length +
    ' แถว'
  );


  writeOverallReportTestSheet_(
    dataRows
  );


  Logger.log(
    'DONE — เขียนลงชีท "' +
    OVERALL_REPORT_TEST_SHEET_NAME_ +
    '" แล้ว ลองเทียบกับหน้าเว็บจริงดูก่อนเอาไปใช้จริง'
  );

}



/*************************************************
 * เปรียบเทียบ Overall Report vs chain เดิม (parent→
 * sub→detail) ในช่วงวันที่แคบเดียวกัน (3 วันล่าสุด)
 * เพื่อหาว่าทำไมจำนวนแถวไม่เท่ากัน (Overall Report
 * ได้ ~1,562 แถว/3 เดือน แต่ chain นับ sub ticket ได้
 * ~2,436 ใบ/3 เดือน) — ช่วงแคบทำให้ fetch detail ทีละ
 * ใบเพื่อดึง ticketNo มาเทียบได้โดยไม่หนักเกินไป
 *
 * normalizeTicketNo_ ตัดส่วน ".R01" ท้าย ticketNo ออก
 * ก่อนเทียบ เพราะคอลัมน์ "Ticket" ใน Overall Report
 * ที่เห็นจากตัวอย่างไม่มีส่วนนี้ต่อท้าย ต่างจาก ticketNo
 * ที่ parseTicketDetail_ ดึงจากหน้า sub ticket detail
 *************************************************/

function normalizeTicketNo_(ticketNo) {

  return String(ticketNo || '')
    .replace(/\.R\d+$/i, '')
    .trim();

}



function testCompareOverallVsChainNarrowRange() {

  const auth =
    rocketLogin_();

  const startDate =
    '26/08/2026';

  const endDate =
    '28/08/2026';


  // ==========================================
  // OVERALL REPORT
  // ==========================================

  const overallRequest =
    buildTicketOverallExportRequest_(
      auth,
      startDate,
      endDate,
      'ajax/report_ticket/overall/export_overall_new.php'
    );

  const overallRes =
    UrlFetchApp.fetch(
      overallRequest.url,
      overallRequest
    );

  const overallRows =
    extractOverallReportRows_(
      overallRes.getBlob()
    );

  const ticketColIndex =
    TICKET_OVERALL_HEADER_MAP_.indexOf(
      'Ticket'
    );

  const overallTicketNos =
    overallRows.map(function(row) {

      return row[ticketColIndex];

    });

  Logger.log(
    'Overall Report: ' +
    overallTicketNos.length +
    ' ใบ\n' +
    overallTicketNos.join(', ')
  );


  // ==========================================
  // CHAIN เดิม (parent → sub → detail)
  // ==========================================

  const parentHtml =
    getParentTicketHtml_(
      auth,
      startDate,
      endDate
    );

  const parentIds =
    extractParentTicketIds_(
      parentHtml
    );

  Logger.log(
    'Chain: parent tickets = ' +
    parentIds.length
  );


  let subIds = [];

  parentIds.forEach(function(parentId) {

    try {

      const html =
        getCheckRepair_(
          parentId,
          auth
        );

      subIds =
        subIds.concat(
          extractCheckRepairIds_(html)
        );

    } catch (e) {

      Logger.log(
        'ERROR parent ' +
        parentId +
        ': ' +
        e.message
      );

    }

  });

  subIds =
    [...new Set(subIds)];

  Logger.log(
    'Chain: sub tickets = ' +
    subIds.length
  );


  const chainTicketNos = [];

  subIds.forEach(function(subId) {

    try {

      const html =
        getTicketDetailHtml_(
          subId,
          auth
        );

      const ticket =
        parseTicketDetail_(
          html,
          subId
        );

      chainTicketNos.push(
        ticket.ticketNo
      );

    } catch (e) {

      Logger.log(
        'ERROR sub ' +
        subId +
        ': ' +
        e.message
      );

    }

  });

  Logger.log(
    'Chain ticketNos (' +
    chainTicketNos.length +
    '):\n' +
    chainTicketNos.join(', ')
  );


  // ==========================================
  // DIFF
  // ==========================================

  const overallSet =
    new Set(
      overallTicketNos.map(
        normalizeTicketNo_
      )
    );

  const chainSet =
    new Set(
      chainTicketNos.map(
        normalizeTicketNo_
      )
    );


  const inChainNotOverall =
    chainTicketNos.filter(function(t) {

      return !overallSet.has(
        normalizeTicketNo_(t)
      );

    });

  const inOverallNotChain =
    overallTicketNos.filter(function(t) {

      return !chainSet.has(
        normalizeTicketNo_(t)
      );

    });


  Logger.log(
    'มีใน Chain แต่ไม่มีใน Overall Report (' +
    inChainNotOverall.length +
    '):\n' +
    inChainNotOverall.join(', ')
  );

  Logger.log(
    'มีใน Overall Report แต่ไม่มีใน Chain (' +
    inOverallNotChain.length +
    '):\n' +
    inOverallNotChain.join(', ')
  );

}
