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
