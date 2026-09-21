/*************************************************
 * ROCKET75 → GOOGLE SHEETS — "Gasoline"
 *
 * ไฟล์นี้แยกจาก appscript.js/trick2.js โดยตั้งใจ
 * (คนละ sheet, รันอิสระจากกันได้) แต่ยังอยู่ใน Apps
 * Script project เดียวกัน จึงใช้ rocketLogin_, ROCKET
 * จาก appscript.js ได้ตรงๆ (global scope เดียวกัน)
 *
 * ต่างจาก syncRocket75/syncTrick2 ตรงที่หน้านี้
 * (report_gasoline_cost.php) เป็นรายงานสรุปต่อช่าง
 * อยู่แล้ว (ไม่ต้องไล่ parent → sub ticket ทีละใบ) —
 * คอลัมน์เป้าหมาย: Technician Name, Number of Jobs
 * Received, Amount Received
 *
 * ยังไม่รู้โครงสร้าง HTML จริงของหน้านี้ (ตารางมี
 * filter ช่วงวันที่ไหม, table id/class อะไร, ตัวเลข
 * ที่เห็นเป็น 0 ทั้งหมดเพราะ default period ไม่มีข้อมูล
 * หรือเพราะต้องส่ง filter เพิ่ม) เลยต้อง inspect ก่อน
 * เขียน parser จริง (ดู testInspectGasolineReport())
 *************************************************/

const GASOLINE_SHEET_NAME = 'Gasoline';



/*************************************************
 * TEST INSPECT GASOLINE REPORT PAGE
 * (ใช้ครั้งเดียวเพื่อดู HTML จริงของหน้า
 * report_gasoline_cost.php ก่อนเขียน parser)
 *************************************************/

function testInspectGasolineReport() {

  const auth =
    rocketLogin_();


  const url =
    ROCKET.BASE +
    '/main/report_gasoline_cost.php';


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


  const anchor =
    html.indexOf(
      'จำนวนงานที่ได้รับ'
    );


  if (anchor === -1) {

    Logger.log(
      'ไม่เจอคำว่า "จำนวนงานที่ได้รับ" ในหน้านี้ ' +
      '(อาจต้องส่ง filter วันที่เพิ่ม หรือตารางโหลด ' +
      'ผ่าน AJAX แยกต่างหาก) — log 3000 ตัวอักษรแรก ' +
      'ของหน้าไว้ให้ดูแทน:'
    );

    Logger.log(
      html
        .substring(0, 3000)
        .replace(/></g, '>\n<')
    );

    return;

  }


  const start =
    Math.max(
      0,
      anchor - 800
    );

  const end =
    Math.min(
      html.length,
      anchor + 5000
    );


  Logger.log(
    'AROUND TABLE:\n' +
    html
      .substring(start, end)
      .replace(/></g, '>\n<')
  );

}



/*************************************************
 * GASOLINE EXPORT ENDPOINT
 * (พบจาก DevTools Network tab: กดปุ่ม "รายงาน" ใน
 * report_gasoline_cost.php ยิง POST ไปที่ endpoint
 * นี้ ตอบกลับเป็นไฟล์ที่ตั้งชื่อ .xlsx แต่ Content-Type
 * เป็น application/vnd.ms-excel (ของเก่า) ซึ่งมักจะ
 * เป็นแค่ตาราง HTML สวมชื่อไฟล์ Excel — ต้อง
 * testGasolineExport() ดูก่อนว่าจริงไหม
 *
 * payload จาก browser ไม่มี token/key (browser ใช้
 * cookie/session ของตัวเอง) แต่ Apps Script ส่วนใหญ่
 * ไม่มี cookie (ดู COOKIE=NO ใน log อื่นๆ) เลยแนบ
 * token/key ไปด้วยกันเผื่อไว้ — ถ้า server ไม่ใช้ก็
 * แค่เพิกเฉยฟิลด์ส่วนเกิน ไม่เสียหาย
 *************************************************/

function buildGasolineExportRequest_(
  auth,
  startDate,
  endDate
) {

  const headers = {

    Origin:
      ROCKET.BASE,

    Referer:
      ROCKET.BASE +
      '/main/report_gasoline_cost.php',

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
      '/main/ajax/report_ticket/gasoline/export_cost_all.php',

    method:
      'post',

    payload: {

      start_date:
        startDate,

      end_date:
        endDate,

      search_team:
        'x',

      search_staff:
        'x',

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



function testGasolineExport() {

  const auth =
    rocketLogin_();


  const request =
    buildGasolineExportRequest_(
      auth,
      ROCKET.START_DATE,
      ROCKET.END_DATE
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


  // ตอบกลับเป็นไฟล์ .xlsx จริง (ZIP binary — เจอ
  // ลายเซ็น "PK" ตอน inspect ครั้งก่อน) getContentText
  // จะทำ binary เพี้ยน ต้องใช้ getBlob() แทน
  const blob =
    res.getBlob();

  Logger.log(
    'Blob size: ' +
    blob.getBytes().length +
    ' bytes'
  );

}



/*************************************************
 * INDIVIDUAL (รายบุคคล) GASOLINE EXPORT ENDPOINT
 * (พบจาก DevTools: หน้า "รายงานค่าน้ำมัน" โหมด
 * ประเภท=รายบุคคล ยิง POST ไปที่
 * ajax/report_ticket/gasoline/export_cost.php
 * (คนละตัวกับ export_cost_all.php ที่ใช้กับโหมด
 * "ทั้งหมด") payload จริงจาก browser:
 *   start_date, end_date, search_team=<team id ตัวเลข>,
 *   search_staff=<staff id ตัวเลข>
 * — UI บังคับให้เลือกทีม+ช่างทีละคน (ช่างเป็น sub
 * ของทีม) แต่ยังไม่รู้ว่า backend บังคับด้วยไหม หรือ
 * รับ 'x' (ทั้งหมด) ได้เหมือน export_cost_all.php —
 * testGasolineIndividualKnown() ทดสอบด้วย id จริงที่
 * เจอจาก network ก่อน (control กลุ่ม ควรผ่านแน่นอน)
 * testGasolineIndividualAll() ทดสอบด้วย 'x' ทั้งคู่
 * ว่า backend ยอมให้ดึงทุกคนพร้อมกันไหม
 *************************************************/

function buildGasolineIndividualRequest_(
  auth,
  startDate,
  endDate,
  teamId,
  staffId
) {

  const headers = {

    Origin:
      ROCKET.BASE,

    Referer:
      ROCKET.BASE +
      '/main/report_gasoline_cost.php',

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
      '/main/ajax/report_ticket/gasoline/export_cost.php',

    method:
      'post',

    payload: {

      start_date:
        startDate,

      end_date:
        endDate,

      search_team:
        String(teamId),

      search_staff:
        String(staffId),

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



function testGasolineIndividualKnown() {

  const auth =
    rocketLogin_();


  const request =
    buildGasolineIndividualRequest_(
      auth,
      '21/08/2026',
      '27/08/2026',
      '6371395077',
      '9760743697'
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
      ' — log 1000 ตัวแรกแทน:\n' +
      blob.getDataAsString('UTF-8').substring(0, 1000)
    );

  }

}



function testGasolineIndividualAll() {

  const auth =
    rocketLogin_();


  const request =
    buildGasolineIndividualRequest_(
      auth,
      '21/08/2026',
      '27/08/2026',
      'x',
      'x'
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


    const sheet1 =
      files.filter(function(f) {

        return (
          f.getName() ===
          'xl/worksheets/sheet1.xml'
        );

      })[0];

    if (sheet1) {

      const rowCount =
        (
          sheet1.getDataAsString('UTF-8')
            .match(/<row\b/g) ||
          []
        ).length;

      Logger.log(
        'จำนวน <row> ทั้งหมดใน sheet1.xml: ' +
        rowCount
      );

    }

  } catch (e) {

    Logger.log(
      'ไม่ใช่ zip/xlsx (แปลว่า server อาจ reject ' +
      'ค่า x ก็ได้): ' +
      e.message +
      ' — log 1000 ตัวแรกแทน:\n' +
      blob.getDataAsString('UTF-8').substring(0, 1000)
    );

  }

}



/*************************************************
 * TEST INSPECT XLSX INTERNAL STRUCTURE
 * (.xlsx คือไฟล์ ZIP ที่ข้างในเป็น XML ธรรมดา —
 * Utilities.unzip() เป็นฟังก์ชันมาตรฐานของ Apps
 * Script ไม่ต้องเปิด Advanced Service เพิ่ม — ใช้
 * ดูโครงสร้าง XML จริงก่อนเขียน parser)
 *************************************************/

function testInspectGasolineXlsx() {

  const auth =
    rocketLogin_();


  const request =
    buildGasolineExportRequest_(
      auth,
      ROCKET.START_DATE,
      ROCKET.END_DATE
    );


  const res =
    UrlFetchApp.fetch(
      request.url,
      request
    );


  // เนื้อไฟล์เป็น zip จริง แต่ Content-Type header
  // จากเซิร์ฟเวอร์เป็น application/vnd.ms-excel (ของ
  // เก่า) ทำให้ Utilities.unzip() ปฏิเสธ ต้อง relabel
  // เป็น application/zip ก่อน (ไม่ใช่การแปลงข้อมูล
  // แค่บอก Apps Script ว่าจริงๆ มันคือ zip)
  const blob =
    res.getBlob()
      .setContentType('application/zip');


  const files =
    Utilities.unzip(blob);


  files.forEach(function(f) {

    Logger.log(
      'FILE: ' +
      f.getName() +
      ' (' +
      f.getBytes().length +
      ' bytes)'
    );

  });


  const sheet1 =
    files.filter(function(f) {

      return (
        f.getName() ===
        'xl/worksheets/sheet1.xml'
      );

    })[0];


  if (sheet1) {

    Logger.log(
      'SHEET1 XML:\n' +
      sheet1
        .getDataAsString('UTF-8')
        .replace(/></g, '>\n<')
        .substring(0, 4000)
    );

  } else {

    Logger.log(
      'ไม่เจอ xl/worksheets/sheet1.xml — ' +
      'ดูรายชื่อไฟล์ด้านบนว่าจริงๆ ชื่ออะไร'
    );

  }


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
        .substring(0, 3000)
    );

  } else {

    Logger.log(
      'ไม่เจอ xl/sharedStrings.xml ' +
      '(อาจใช้ inline string ในเซลล์แทน)'
    );

  }

}



/*************************************************
 * PARSE XLSX (ดูโครงสร้างจริงจาก
 * testInspectGasolineXlsx() log):
 *   - แถวหัวตาราง (r="4"): B=ลำดับ, C=ชื่อช่าง,
 *     D=จำนวนงานที่ได้รับ, E=จำนวนเงินที่ได้รับ
 *   - แถวข้อมูล (r="5" เป็นต้นไป): 1 แถว/ช่าง 1 คน
 *   - แถวสุดท้ายเป็นแถวรวม (ชื่อช่าง = "รวม") ต้อง
 *     ข้าม
 *   - ตัวเลขจำนวนเงินที่ >= 1,000 เซิร์ฟเวอร์ export
 *     เป็น shared string ที่มี comma คั่นหลักพัน (เช่น
 *     "1,260") แทนที่จะเป็นตัวเลขตรงๆ ต้องตัด comma
 *     ออกก่อนแปลงเป็นตัวเลข
 *
 * หา header/แถวรวมโดยเทียบข้อความจริง ไม่ใช้เลข
 * แถวตายตัว เผื่อเดือนอื่นจำนวนช่าง/แถวไม่เท่ากัน
 *************************************************/

function decodeXmlEntities_(text) {

  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

}



function parseSharedStrings_(xml) {

  const strings = [];

  const siRegex =
    /<si>([\s\S]*?)<\/si>/g;

  let siMatch;


  while (
    (siMatch = siRegex.exec(xml))
    !== null
  ) {

    const tRegex =
      /<t[^>]*>([\s\S]*?)<\/t>/g;

    let text = '';

    let tMatch;


    while (
      (tMatch = tRegex.exec(siMatch[1]))
      !== null
    ) {

      text +=
        tMatch[1];

    }

    strings.push(
      decodeXmlEntities_(text)
    );

  }


  return strings;

}



function parseSheetRows_(sheetXml, sharedStrings) {

  const rows = {};

  const rowRegex =
    /<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;

  let rowMatch;


  while (
    (rowMatch = rowRegex.exec(sheetXml))
    !== null
  ) {

    const rowNum =
      Number(rowMatch[1]);

    const rowContent =
      rowMatch[2];


    const cellRegex =
      /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

    let cellMatch;

    const cells = {};


    while (
      (cellMatch = cellRegex.exec(rowContent))
      !== null
    ) {

      const attrs =
        cellMatch[1];

      const inner =
        cellMatch[2] ||
        '';


      const colMatch =
        attrs.match(
          /\br="([A-Z]+)\d+"/
        );

      if (!colMatch) {

        continue;

      }

      const col =
        colMatch[1];


      const typeMatch =
        attrs.match(
          /\bt="([a-z]+)"/
        );

      const type =
        typeMatch
          ? typeMatch[1]
          : null;


      // เจอบั๊กจริง: บางเซลล์ชื่อช่างเก็บเป็น inline
      // string (t="inlineStr", ค่าอยู่ใน <is><t>...
      // </t></is>) แทนที่จะเป็น shared string (t="s",
      // ค่าอยู่ใน <v>index</v>) — โค้ดเดิมมองหาแค่ <v>
      // อย่างเดียว พอเจอ inlineStr เลยได้ค่าว่างเปล่า
      // แล้วโดน filter ทิ้งเงียบๆ (ชื่อว่าง = ข้าม)
      // ทำให้ได้ช่างมาแค่ ~32 คน จาก 62 คนจริง
      if (type === 'inlineStr') {

        const isMatch =
          inner.match(
            /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/
          );

        cells[col] =
          isMatch
            ? decodeXmlEntities_(isMatch[1])
            : '';

        continue;

      }


      const vMatch =
        inner.match(
          /<v>([\s\S]*?)<\/v>/
        );

      const rawValue =
        vMatch
          ? vMatch[1]
          : '';


      cells[col] =
        type === 's'
          ? (sharedStrings[Number(rawValue)] || '')
          : rawValue;

    }


    rows[rowNum] =
      cells;

  }


  return rows;

}



function parseNumberCell_(value) {

  const n =
    Number(
      String(value || '0')
        .replace(/,/g, '')
    );

  return isNaN(n)
    ? 0
    : n;

}



function extractGasolineReport_(blob) {

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

  const sheetXml =
    sheetFile.getDataAsString('UTF-8');


  const rows =
    parseSheetRows_(
      sheetXml,
      sharedStrings
    );


  const rowNumbers =
    Object.keys(rows)
      .map(Number)
      .sort(function(a, b) {

        return a - b;

      });


  const result = [];

  let skippedEmptyName = 0;


  rowNumbers.forEach(function(rowNum) {

    const cells =
      rows[rowNum];

    const name =
      cells['C'];


    if (
      !name ||
      name === 'ชื่อช่าง' ||
      name === 'รวม'
    ) {

      // นับแยกไว้เฉพาะแถวที่ "ควรจะ" มีชื่อแต่ดัน
      // ว่างเปล่า (ไม่ใช่แถวว่างจริงๆ /header/แถวรวม)
      // เพื่อเตือนถ้าเกิดบั๊กแบบ inlineStr ซ้ำอีกใน
      // อนาคต จะได้ไม่เงียบหายแบบครั้งนี้
      if (
        name === '' &&
        cells['B'] !== undefined
      ) {

        skippedEmptyName++;

      }

      return;

    }


    result.push({

      name: name,

      jobs:
        parseNumberCell_(cells['D']),

      amount:
        parseNumberCell_(cells['E'])

    });

  });


  if (skippedEmptyName > 0) {

    Logger.log(
      'คำเตือน: ข้ามไป ' +
      skippedEmptyName +
      ' แถวเพราะดึงชื่อช่างไม่ได้ (ชื่อว่างเปล่า) — ' +
      'อาจมีเซลล์ประเภทที่ parser ยังไม่รองรับ ' +
      'ตรวจสอบผลรวมในชีทเทียบกับรายงานต้นฉบับด้วย'
    );

  }


  return result;

}



/*************************************************
 * MAIN
 * (ไฟล์เล็ก (~20KB) fetch + parse + เขียนจบใน request
 * เดียว ไม่ต้อง chunk/resume แบบ syncRocket75/
 * syncTrick2 — เขียนทับทั้งชีทใหม่ทุกครั้งเพราะรายงาน
 * นี้เป็น snapshot สรุปยอดของช่วงวันที่ที่กำหนด ไม่ใช่
 * ข้อมูลราย ticket ที่ต้อง upsert ทีละรายการ)
 *************************************************/

function syncGasoline() {

  Logger.log(
    '========== GASOLINE SYNC =========='
  );


  const auth =
    rocketLogin_();

  Logger.log(
    'LOGIN OK'
  );


  const request =
    buildGasolineExportRequest_(
      auth,
      ROCKET.START_DATE,
      ROCKET.END_DATE
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
      'Gasoline export HTTP ' +
      res.getResponseCode()
    );

  }


  const rows =
    extractGasolineReport_(
      res.getBlob()
    );

  Logger.log(
    'พบช่าง ' +
    rows.length +
    ' คน'
  );


  writeGasolineSheet_(
    rows
  );


  Logger.log(
    'DONE'
  );

}



const GASOLINE_HEADERS_ = [

  'Technician Name',
  'Number of Jobs Received',
  'Amount Received',
  'Last Sync'

];



function writeGasolineSheet_(rows) {

  const ss =
    SpreadsheetApp
      .getActiveSpreadsheet();


  let sheet =
    ss.getSheetByName(
      GASOLINE_SHEET_NAME
    );


  if (!sheet) {

    sheet =
      ss.insertSheet(
        GASOLINE_SHEET_NAME
      );

  }


  // รายงานนี้เขียนทับทั้งชีทเป็น snapshot เดียว
  // (ไม่ใช่ upsert ทีละแถวเหมือนชีทอื่น) เลยใช้เวลา
  // sync ครั้งนี้ค่าเดียวกันทุกแถว แทนที่จะมี lastSync
  // แยกต่อรายการเหมือน Tickets/Trick2
  const lastSync =
    formatDateForSheet_(
      new Date()
    );


  sheet.clearContents();


  const dataRows =
    rows.map(function(r) {

      return [

        r.name,
        r.jobs,
        r.amount,
        lastSync

      ];

    });

  const values =
    [GASOLINE_HEADERS_].concat(
      dataRows
    );


  sheet.getRange(
    1,
    1,
    values.length,
    GASOLINE_HEADERS_.length
  ).setValues(
    values
  );

}



/*************************************************
 * TEST INSPECT TEAM/STAFF DROPDOWN DATA
 * (export_cost.php ต้องการ search_team + search_staff
 * เป็น ID ตัวเลข แต่รายงานสรุป export_cost_all.php
 * คืนมาแค่ "ชื่อ" ไม่มี ID — ต้องหาว่าหน้า
 * report_gasoline_cost.php เอง (ตอนโหลดแรก ก่อนกด
 * export) ฝัง mapping ชื่อ→ID มาให้ในหน้าเลยไหม เช่น
 * <select><option value="9760743697">จิรัสกฤต...
 * </option></select> หรือ var teams = [...] ใน
 * <script> — ถ้าเจอ ก็ parse เอา ID ออกมาแทนที่จะ
 * ต้องเปิด DevTools ไล่ทีละคน
 *************************************************/

function testInspectGasolineDropdowns() {

  const auth =
    rocketLogin_();


  const url =
    ROCKET.BASE +
    '/main/report_gasoline_cost.php';


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


  const html =
    res.getContentText('UTF-8');

  Logger.log(
    'HTML length: ' +
    html.length
  );


  const selectRegex =
    /<select[^>]*\bid=["']?(search_team|search_staff)["']?[^>]*>([\s\S]*?)<\/select>/g;

  let selectMatch;

  let foundSelect = false;


  while (
    (selectMatch = selectRegex.exec(html))
    !== null
  ) {

    foundSelect = true;

    const selectId =
      selectMatch[1];

    const optionsHtml =
      selectMatch[2];


    const optionRegex =
      /<option[^>]*\bvalue=["']?([^"'>\s]*)["']?[^>]*>([\s\S]*?)<\/option>/g;

    let optionMatch;

    let count = 0;


    Logger.log(
      '=== <select id="' +
      selectId +
      '"> ==='
    );


    while (
      (optionMatch = optionRegex.exec(optionsHtml))
      !== null
    ) {

      count++;

      if (count <= 30) {

        Logger.log(
          '  value="' +
          optionMatch[1] +
          '" text="' +
          cleanText_(optionMatch[2]) +
          '"'
        );

      }

    }


    Logger.log(
      selectId +
      ' total options: ' +
      count
    );

  }


  if (!foundSelect) {

    Logger.log(
      'ไม่เจอ <select id="search_team"/"search_staff"> ' +
      'ตรงๆ — ลองหา data-* attribute หรือ JS array แทน'
    );


    const scriptDataMatches =
      html.match(
        /var\s+(team|staff|technician)\w*\s*=\s*\[[\s\S]{0,500}/gi
      );

    if (scriptDataMatches) {

      scriptDataMatches.forEach(function(m) {

        Logger.log(
          'พบ JS array candidate:\n' +
          m.substring(0, 500)
        );

      });

    } else {

      Logger.log(
        'ไม่เจอ JS array ที่มีคำว่า team/staff/technician ' +
        'เลย — log 3000 ตัวแรกของหน้าไว้ดูแทน:\n' +
        html.substring(0, 3000).replace(/></g, '>\n<')
      );

    }

  }

}



/*************************************************
 * GASOLINE — EXPORT ต่อทีม (export_cost_team.php)
 * (พบว่าหน้ารายงานเปลี่ยนรูปแบบมาเป็น "สรุปรายได้
 * ช่างรายบุคคล" แยกต่อทีม — payload จริงจาก DevTools:
 *   start_date, end_date, search_team=<team id ตัวเลข>,
 *   search_staff=x
 * ต่างจาก export_cost.php (รายบุคคลเดิม) ตรงที่
 * search_staff='x' ใช้ได้จริง (ได้ทุกช่างในทีมนั้น
 * มาในไฟล์เดียว) ไม่ต้องรู้ staff id เป็นรายคน — มีแค่
 * 4 ทีมทั้งหมด (ตามที่ผู้ใช้บอก) แปลว่า sync ให้ครบ
 * ทุกช่างทำได้ด้วย 4 request เท่านั้น (ไม่ใช่ ~62
 * request ต่อช่างแบบที่กังวลไว้แต่แรก)
 *
 * โครงสร้างตาราง (จากสกรีนช็อตที่ผู้ใช้ส่งมา) มีแถว
 * หัวเรื่อง/ช่วงวันที่/ชื่อทีมนำหน้าคอลัมน์จริงอีก 3
 * แถว (ต่างจาก export_cost_all.php ที่ header อยู่
 * แถว 4 ตรงๆ) ต้อง inspect โครงสร้าง XML จริงก่อน
 * เขียน parser (ดู testInspectGasolineTeamXlsx())
 *
 * ทดสอบแค่ทีมเดียวก่อนตามที่ผู้ใช้ขอ — teamId นี้คือ
 * "ช่าง A (BK)" จาก payload จริงที่ capture มา
 *************************************************/

function buildGasolineTeamExportRequest_(
  auth,
  startDate,
  endDate,
  teamId
) {

  const headers = {

    Origin:
      ROCKET.BASE,

    Referer:
      ROCKET.BASE +
      '/main/report_gasoline_cost.php',

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
      '/main/ajax/report_ticket/gasoline/export_cost_team.php',

    method:
      'post',

    payload: {

      start_date:
        startDate,

      end_date:
        endDate,

      search_team:
        String(teamId),

      search_staff:
        'x',

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



function testGasolineTeamExport() {

  const auth =
    rocketLogin_();


  const teamId =
    '8002371330';

  const request =
    buildGasolineTeamExportRequest_(
      auth,
      '30/07/2026',
      '29/08/2026',
      teamId
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
      ' — log 1000 ตัวแรกแทน:\n' +
      blob.getDataAsString('UTF-8').substring(0, 1000)
    );

  }

}



function testInspectGasolineTeamXlsx() {

  const auth =
    rocketLogin_();


  const teamId =
    '8002371330';

  const request =
    buildGasolineTeamExportRequest_(
      auth,
      '30/07/2026',
      '29/08/2026',
      teamId
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
 * PARSE + SYNC ทดสอบ export_cost_team.php (ทีมเดียว)
 * (ยืนยันโครงสร้างจริงจาก testInspectGasolineTeamXlsx()
 * log แล้ว:
 *   แถว 1 = ชื่อรายงาน "สรุปรายได้ช่างรายบุคคล"
 *   แถว 2 = ช่วงวันที่
 *   แถว 3 = ชื่อทีม เช่น " ช่าง A (BK)"
 *   (ทั้ง 3 แถวนี้มีค่าแค่คอลัมน์ A เท่านั้น — เหมือน
 *   merge cell แต่จริงๆ คอลัมน์อื่นว่างเปล่าธรรมดา)
 *   แถว 4 = header จริง: A=วันที่ถึงหน้างาน,
 *     B=เลขที่ใบงาน, C=เลขที่งาน (BK), D=ชื่อลูกค้า,
 *     E=ชื่อช่าง, F=ผลรวม, G=หมายเหตุ
 *   แถว 5+ = ข้อมูลจริง 1 แถว/1 ticket — B (เลขที่
 *     ใบงาน) บางแถวว่างเปล่าได้ (เจอจริงจากตัวอย่าง)
 *
 * หา header row จากข้อความจริง ("วันที่ถึงหน้างาน")
 * ไม่ยึดเลขแถวตายตัว เผื่อจำนวนแถว title เปลี่ยนใน
 * อนาคต — คอลัมน์ "ผลรวม" (F) เป็น 0/1 บอกว่า ticket
 * นี้นับเป็นงานที่ได้ค่าน้ำมันไหม (0 = ไม่นับ เช่น
 * "ปิดงานล่าช้า"/"ลงรายละเอียดใบงานไม่ครบถ้วน") ใช้
 * รวมยอดจริงได้ตรงกับ Gasoline sheet (aggregate)
 * ที่มีอยู่แล้ว: SUM(ผลรวม) ต่อช่าง = Number of Jobs
 * Received, × 70 = Amount Received
 *************************************************/

function extractGasolineTeamRows_(blob) {

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


  let headerRowNum = null;

  rowNumbers.forEach(function(rowNum) {

    if (
      headerRowNum === null &&
      rows[rowNum]['A'] === 'วันที่ถึงหน้างาน'
    ) {

      headerRowNum = rowNum;

    }

  });


  if (headerRowNum === null) {

    throw new Error(
      'ไม่เจอแถว header ("วันที่ถึงหน้างาน") ในรายงานนี้ ' +
      '— โครงสร้างอาจเปลี่ยนไปจากที่เคย inspect ไว้'
    );

  }


  // ชื่อทีม (เช่น " ช่าง A (BK)") อยู่แถวก่อนหน้า header
  // ทันที (แถว 3 ตามที่ inspect ไว้) — ดึงจากตัวรายงาน
  // เองแทนที่จะ hardcode ชื่อทีม เผื่อเปลี่ยนชื่อทีมทีหลัง
  const teamNameRow =
    rows[headerRowNum - 1];

  const teamName =
    teamNameRow && teamNameRow['A']
      ? String(teamNameRow['A']).trim()
      : '';


  const result = [];


  rowNumbers.forEach(function(rowNum) {

    if (rowNum <= headerRowNum) {

      return;

    }


    const cells =
      rows[rowNum];

    const ticketNo =
      cells['C'];

    if (!ticketNo) {

      return;

    }


    result.push({

      arrivedDate:
        cells['A'] || '',

      jobNo:
        cells['B'] || '',

      ticketNo:
        ticketNo,

      customer:
        cells['D'] || '',

      technician:
        cells['E'] || '',

      team:
        teamName,

      counted:
        parseNumberCell_(cells['F']),

      remarks:
        cells['G'] || ''

    });

  });


  return result;

}



const GASOLINE_DETAIL_TEST_SHEET_NAME_ =
  'Gasoline Detail (Test)';

// A-J เป็นคอลัมน์ข้อมูลที่ sync เขียนทับได้ทุกรอบ
// K (Review) และ L (Note) เป็นคอลัมน์ให้คนกรอกเอง
// M (Count Stack) และ N (Amount Received) เป็นสูตร
// ในชีท — ทั้ง 4 คอลัมน์นี้ sync จะไม่แตะซ้ำถ้าแถว
// นั้นมีอยู่แล้ว (ดู batchUpsertGasolineDetail_)
// Team (F) มาจากแถวชื่อทีมในรายงานเอง (แถวก่อนหน้า
// header row) ไม่ใช่ค่าคงที่ — เผื่อรวม 4 ทีมทีหลัง
// จะได้แยกได้ว่าแต่ละแถวมาจากทีมไหน
const GASOLINE_DETAIL_HEADERS_ = [

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


// เรทต่อ 1 งานที่ approve แล้ว — ผู้ใช้ระบุ 80 ตรงนี้
// (ต่างจากค่า 70 ที่เคย confirm ไว้ก่อนหน้าจากรายงาน
// สรุปรวม export_cost_all.php — ถ้า 80 ไม่ใช่ค่าตั้งใจ
// ให้แก้ค่านี้ที่เดียว)
const GASOLINE_RATE_PER_JOB_ = 80;



/*************************************************
 * หา URL ของแต่ละ ticket จากชีท Tickets ที่มีอยู่แล้ว
 * (syncRocket75) — รายงาน gasoline ไม่มี ticket ID
 * ตัวเลขให้ ต้อง join ด้วย Ticket No. (ข้อความ เช่น
 * "BKIN0726-000526.R01") แทน ซึ่งใช้รูปแบบเดียวกัน
 * กับคอลัมน์ "Ticket No" ของชีท Tickets พอดี ไม่ต้อง
 * normalize — ticket ที่ยังไม่เคย sync ใน Tickets จะ
 * ได้ URL ว่างเปล่า (ไม่ใช่ error)
 *************************************************/

function getTicketNoToUrlMap_() {

  const map = {};

  const sheet =
    SpreadsheetApp
      .getActiveSpreadsheet()
      .getSheetByName(
        ROCKET.TICKET_SHEET
      );

  if (!sheet) {

    return map;

  }


  const lastRow =
    sheet.getLastRow();

  if (lastRow < 2) {

    return map;

  }


  const ticketNoCol =
    TICKET_HEADERS_.indexOf(
      'Ticket No'
    ) + 1;

  const urlCol =
    TICKET_HEADERS_.indexOf(
      'URL'
    ) + 1;

  const ticketNos =
    sheet.getRange(
      2,
      ticketNoCol,
      lastRow - 1,
      1
    ).getDisplayValues();

  const urls =
    sheet.getRange(
      2,
      urlCol,
      lastRow - 1,
      1
    ).getDisplayValues();


  for (
    let i = 0;
    i < ticketNos.length;
    i++
  ) {

    const ticketNo =
      ticketNos[i][0];

    if (ticketNo) {

      map[ticketNo] =
        urls[i][0];

    }

  }


  return map;

}



/*************************************************
 * สูตร Count Stack / Amount Received
 * (ใช้เฉพาะตอนสร้างแถวใหม่เท่านั้น — แถวเดิมที่มีอยู่
 * แล้วไม่แตะซ้ำ กันคนแก้ Review ไปแล้วสูตรโดนเขียนทับ)
 *
 * Count Stack: นับสะสมจากแถวบนสุด (แถว 2) ลงมาถึง
 * แถวตัวเอง เฉพาะแถวที่ Technician Name ตรงกับตัวเอง
 * + Counted > 0 + Review = "Approved" — ได้ "งานลำดับ
 * ที่เท่าไหร่ของช่างคนนี้ที่ approve แล้ว" ต่อแถว
 * **แต่แสดงค่าเฉพาะแถวที่ตัวเอง Approved แล้วเท่านั้น**
 * (เจอบั๊กจริง: ถ้าไม่เช็คเงื่อนไขนี้ แถวที่ยังไม่ได้
 * approve จะโชว์เลขค้างจากยอดสะสมของแถวก่อนหน้าไปเรื่อยๆ
 * ดูเหมือนแถวนั้น approve ไปแล้วทั้งที่จริงยังไม่ได้กด) —
 * ห่อด้วย IF เช็คแถวตัวเองก่อน ถ้ายังไม่ Approved
 * (หรือ Counted ไม่เกิน 0) ให้ว่างเปล่าไปเลย
 * Amount Received: Count Stack ของแถวนั้น × 80
 * (ว่างเปล่าตามไปด้วยถ้า Count Stack ว่าง)
 *************************************************/

function gasolineCountStackFormula_(rowNum) {

  return (
    '=IF(AND(G' + rowNum + '>0,K' + rowNum + '="Approved"),' +
    'COUNTIFS(' +
    '$E$2:E' + rowNum + ',E' + rowNum + ',' +
    '$G$2:G' + rowNum + ',">0",' +
    '$K$2:K' + rowNum + ',"Approved"),"")'
  );

}



function gasolineAmountFormula_(rowNum) {

  return (
    '=IF(M' + rowNum + '="","",M' + rowNum +
    '*' + GASOLINE_RATE_PER_JOB_ + ')'
  );

}



function buildGasolineDetailRowIndex_(sheet) {

  sheet.getRange(
    1,
    1,
    1,
    GASOLINE_DETAIL_HEADERS_.length
  ).setValues(
    [GASOLINE_DETAIL_HEADERS_]
  );


  const index = {};

  // เก็บไว้ว่าแถวไหนมีสูตร Count Stack (คอลัมน์ M)
  // อยู่แล้วบ้าง — แถวที่ sync ไว้ตั้งแต่ก่อนเพิ่ม
  // คอลัมน์ M/N เข้ามาจะไม่มีสูตรเลย ต้องมา backfill
  // ให้ทีหลัง (ดู batchUpsertGasolineDetail_)
  const hasFormula = {};

  const lastRow =
    sheet.getLastRow();


  if (lastRow >= 2) {

    const ticketNos =
      sheet.getRange(
        2,
        3,
        lastRow - 1,
        3
      ).getDisplayValues();

    const countStackFormulas =
      sheet.getRange(
        2,
        13,
        lastRow - 1,
        1
      ).getFormulas();

    ticketNos.forEach(function(row, i) {

      if (row[0]) {

        const rowNum =
          i + 2;

        index[String(row[0]).trim() + '__' + String(row[2] || '').trim()] =
          rowNum;

        hasFormula[rowNum] =
          countStackFormulas[i][0] !== '';

      }

    });

  }


  return {

    sheet: sheet,
    index: index,
    hasFormula: hasFormula,
    lastRow: lastRow

  };

}



/*************************************************
 * UPSERT — key คือ Ticket No. (BK) (คอลัมน์ C)
 * แถวเดิม: เขียนทับแค่ A:I (ข้อมูลจาก sync) ปล่อย
 *   J (Review), K (Note), L/M (สูตร) ไว้เหมือนเดิม
 * แถวใหม่: เขียนเต็ม A:M — Review/Note ว่างเปล่าไว้
 *   ให้คนกรอกทีหลัง, ใส่สูตร Count Stack/Amount
 *   Received ให้เลย
 *************************************************/

function batchUpsertGasolineDetail_(
  rows,
  ctx,
  urlMap,
  lastSync
) {

  if (rows.length === 0) {

    return;

  }


  const spreadsheetId =
    SpreadsheetApp
      .getActiveSpreadsheet()
      .getId();

  const sheetName =
    ctx.sheet.getName();

  const data = [];

  const newRows = [];


  const uniqueRows = new Map();
  const ticketDateMap = {};

  rows.forEach(function(r) {
    const ticketKey = String(r.ticketNo || '').trim();
    const parentKey = ticketKey.replace(/\.[A-Z0-9]+$/i, '').trim();
    const arrived = String(r.arrivedDate || '').trim();
    if (arrived) {
      if (ticketKey && !ticketDateMap[ticketKey]) ticketDateMap[ticketKey] = arrived;
      if (parentKey && !ticketDateMap[parentKey]) ticketDateMap[parentKey] = arrived;
    }
  });

  rows.forEach(function(r) {
    uniqueRows.set(String(r.ticketNo).trim() + '__' + String(r.technician || '').trim(), r);
  });
  uniqueRows.forEach(function(r) {

    const url =
      urlMap[r.ticketNo] ||
      '';

    const ticketKey = String(r.ticketNo || '').trim();
    const parentKey = ticketKey.replace(/\.[A-Z0-9]+$/i, '').trim();
    const arrivedDate = r.arrivedDate ||
      ticketDateMap[ticketKey] ||
      (parentKey && ticketDateMap[parentKey]) ||
      '';

    const dataRow = [

      arrivedDate,
      r.jobNo,
      r.ticketNo,
      r.customer,
      r.technician,
      r.team,
      r.counted,
      r.remarks,
      lastSync,
      url

    ];

    const existingRow =
      ctx.index[String(r.ticketNo).trim() + '__' + String(r.technician || '').trim()];


    if (existingRow) {

      data.push({

        range:
          "'" + sheetName + "'!A" +
          existingRow + ':J' +
          existingRow,

        values: [dataRow]

      });


      // backfill สูตรให้แถวเก่าที่ sync มาตั้งแต่ก่อน
      // เพิ่มคอลัมน์ M/N เข้ามา (ไม่งั้นแถวพวกนี้จะไม่มี
      // สูตรตลอดไป) — แถวที่มีสูตรอยู่แล้วไม่แตะซ้ำ
      if (!ctx.hasFormula[existingRow]) {

        data.push({

          range:
            "'" + sheetName + "'!M" +
            existingRow + ':N' +
            existingRow,

          values: [[

            gasolineCountStackFormula_(existingRow),
            gasolineAmountFormula_(existingRow)

          ]]

        });

        ctx.hasFormula[existingRow] = true;

      }

    } else {

      newRows.push({

        ticketNo: r.ticketNo,
        technician: r.technician,
        dataRow: dataRow

      });

    }

  });


  if (newRows.length > 0) {

    const startRow =
      ctx.lastRow + 1;

    const fullRows =
      newRows.map(function(nr, i) {

        const rowNum =
          startRow + i;

        return nr.dataRow.concat([

          '',
          '',
          gasolineCountStackFormula_(rowNum),
          gasolineAmountFormula_(rowNum)

        ]);

      });

    data.push({

      range:
        "'" + sheetName + "'!A" +
        startRow + ':N' +
        (startRow + newRows.length - 1),

      values: fullRows

    });

    newRows.forEach(function(nr, i) {

      ctx.index[String(nr.ticketNo).trim() + '__' + String(nr.technician || '').trim()] =
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



function applyGasolineReviewValidation_(
  sheet,
  lastRow
) {

  if (lastRow < 2) {

    return;

  }


  const rule =
    SpreadsheetApp
      .newDataValidation()
      .requireValueInList(
        ['Approved', 'Not Approved'],
        true
      )
      .setAllowInvalid(false)
      .build();


  sheet.getRange(
    2,
    11,
    lastRow - 1,
    1
  ).setDataValidation(rule);

}



// ดึงครบทั้ง 4 ทีม (GASOLINE_TEAM_IDS_) รวมเป็นชุดเดียว
// ก่อนเขียนลงชีททดสอบ — ยังไม่แตะ Gasoline sheet จริง
// จนกว่าจะยืนยันข้อมูลถูกต้องแล้ว
// 4 ทีมที่มีช่างจริง (ยืนยันจาก dropdown "ทีม" ของหน้า
// report_gasoline_cost.php — testInspectGasolineDropdowns())
// ทีมอื่นๆ ในรายการ 19 ทีม (Admin Web, Call Center,
// บัญชี, ผู้บริหาร ฯลฯ) เป็นทีมฝ่ายอื่น ไม่เกี่ยวกับ
// ค่าน้ำมันช่าง เลยไม่รวมมาด้วย
const GASOLINE_TEAM_IDS_ = [

  { id: '8002371330', label: 'A (BK)' },
  { id: '6371395077', label: 'B (BK)' },
  { id: '3696295156', label: 'Training' },
  { id: '9751260652', label: 'หัวหน้าช่าง' }

];



function syncGasolineTeamTest() {

  Logger.log(
    '========== GASOLINE TEAM SYNC (TEST — 4 ทีม) =========='
  );


  const auth =
    rocketLogin_();

  Logger.log(
    'LOGIN OK'
  );


  let rows = [];


  GASOLINE_TEAM_IDS_.forEach(function(team) {

    const request =
      buildGasolineTeamExportRequest_(
        auth,
        '30/07/2026',
        '29/08/2026',
        team.id
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

      Logger.log(
        'ERROR ทีม ' +
        team.label +
        ': HTTP ' +
        res.getResponseCode()
      );

      return;

    }


    const teamRows =
      extractGasolineTeamRows_(
        res.getBlob()
      );

    Logger.log(
      'ทีม ' +
      team.label +
      ': พบ ' +
      teamRows.length +
      ' แถว'
    );

    rows =
      rows.concat(teamRows);

  });


  Logger.log(
    'รวมทั้งหมด ' +
    rows.length +
    ' แถว (4 ทีม)'
  );


  const urlMap =
    getTicketNoToUrlMap_();


  const ss =
    SpreadsheetApp
      .getActiveSpreadsheet();

  let sheet =
    ss.getSheetByName(
      GASOLINE_DETAIL_TEST_SHEET_NAME_
    );

  if (!sheet) {

    sheet =
      ss.insertSheet(
        GASOLINE_DETAIL_TEST_SHEET_NAME_
      );

  }


  const ctx =
    buildGasolineDetailRowIndex_(
      sheet
    );

  const lastSync =
    formatDateForSheet_(
      new Date()
    );


  batchUpsertGasolineDetail_(
    rows,
    ctx,
    urlMap,
    lastSync
  );

  applyGasolineReviewValidation_(
    sheet,
    ctx.lastRow
  );


  Logger.log(
    'DONE — เขียนลงชีท "' +
    GASOLINE_DETAIL_TEST_SHEET_NAME_ +
    '" แล้ว (upsert — Review/Note/สูตรเดิมไม่ถูกแตะ)'
  );

}
