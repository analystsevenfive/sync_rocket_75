/*************************************************
 * ROCKET75 → GOOGLE SHEETS
 *
 * Sheets:
 *   1. Tickets
 *
 * Auth:
 *   username/password
 *      ↓
 *   auth.php
 *      ↓
 *   PHPSESSID + token + key
 *************************************************/


// คำนวณช่วงวันที่ sync แบบ "1 สัปดาห์ล่าสุด" อัตโนมัติทุกครั้งที่รัน
// (ย้อนหลัง 6 วันจากวันนี้ ถึงวันนี้ = รวม 7 วัน) ไม่ต้องแก้วันที่มือแล้ว
function computeLastWeekRange_() {

  const timezone =
    Session.getScriptTimeZone();

  const today =
    new Date();

  const weekAgo =
    new Date(
      today.getTime() -
      6 * 24 * 60 * 60 * 1000
    );


  return {

    start:
      Utilities.formatDate(
        weekAgo,
        timezone,
        'dd/MM/yyyy'
      ),

    end:
      Utilities.formatDate(
        today,
        timezone,
        'dd/MM/yyyy'
      )

  };

}



const ROCKET_DATE_RANGE_ =
  computeLastWeekRange_();


const ROCKET = {

  BASE: 'https://rocket75.com',

  START_DATE: ROCKET_DATE_RANGE_.start,
  END_DATE: ROCKET_DATE_RANGE_.end,

  TICKET_SHEET: 'Tickets'

};


/*************************************************
 * MAIN
 *************************************************/

function syncRocket75() {

  const startedAt =
    new Date();

  // เผื่อเวลาไว้ ไม่ให้ชน 6 นาทีของ Apps Script
  const maxRunMs =
    4.5 * 60 * 1000;

  function timeLeftMs_() {

    return (
      maxRunMs -
      (new Date() - startedAt)
    );

  }


  Logger.log(
    '========== ROCKET75 SYNC =========='
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
  // 1. GET PARENT TICKETS (เก็บ state ไว้เผื่อ resume)
  // ==========================================

  let parentIds =
    readJsonProp_(
      props,
      'SYNC_PARENT_IDS'
    );


  if (parentIds === null) {

    // เริ่ม sync cycle ใหม่ (ไม่ใช่ resume ต่อจาก
    // รอบที่ค้าง) ล้างข้อมูลเก่าในชีทก่อนเขียนรอบนี้
    // เสมอ — เช็คจาก parentIds === null เพื่อไม่ให้
    // เผลอ clear ซ้ำตอน resume ต่อ (ไม่งั้นจะลบทับ
    // ข้อมูลที่ chunk ก่อนหน้าเพิ่งเขียนไปเอง)
    clearSheetData();

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
      'SYNC_PARENT_IDS',
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
      'SYNC_PENDING_PARENTS'
    );

  if (pendingParents === null) {

    pendingParents =
      parentIds.slice();

  }


  let subIds =
    readJsonProp_(
      props,
      'SYNC_SUB_IDS'
    ) ||
    [];


  const PARENT_CHUNK =
    20;


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

        const ids =
          extractCheckRepairIds_(
            res.getContentText('UTF-8')
          );

        subIds =
          subIds.concat(ids);

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
      'SYNC_PENDING_PARENTS',
      pendingParents
    );

    writeJsonProp_(
      props,
      'SYNC_SUB_IDS',
      subIds
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
      ' ตัว กด "เรียกใช้" syncRocket75 ซ้ำเพื่อทำต่อ'
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
      'SYNC_PENDING_SUBS'
    );

  if (pendingSubs === null) {

    pendingSubs =
      subIds.slice();

  }


  const ticketCtx =
    buildTicketRowIndex_();

  const SUB_CHUNK =
    15;


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

    batchUpsertTickets_(
      ticketsToWrite,
      ticketCtx
    );

    pendingSubs =
      pendingSubs.slice(
        SUB_CHUNK
      );

    writeJsonProp_(
      props,
      'SYNC_PENDING_SUBS',
      pendingSubs
    );

    Logger.log(
      'เขียนแล้ว ' +
      (subIds.length - pendingSubs.length) +
      '/' +
      subIds.length
    );

  }


  if (pendingSubs.length > 0) {

    Logger.log(
      'ใกล้ timeout — เหลือ ticket อีก ' +
      pendingSubs.length +
      ' ตัว กด "เรียกใช้" syncRocket75 ซ้ำเพื่อทำต่อ'
    );

    return;

  }


  props.deleteProperty('SYNC_PARENT_IDS');
  props.deleteProperty('SYNC_PENDING_PARENTS');
  props.deleteProperty('SYNC_SUB_IDS');
  props.deleteProperty('SYNC_PENDING_SUBS');


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
 * FETCH ALL แบบมี RETRY + FALLBACK
 * (UrlFetchApp.fetchAll ยิงหลาย request พร้อมกัน
 * ถ้าตัวใดตัวหนึ่งเจอปัญหาระดับ connection เช่น
 * "Address unavailable" มันจะ throw exception
 * ทั้งชุดทันที แม้ตั้ง muteHttpExceptions ไว้แล้ว
 * ก็ตาม (flag นั้นดักแค่ HTTP 4xx/5xx ไม่ได้ดัก
 * connection-level failure) เลยต้อง retry ทั้งชุด
 * ก่อน ถ้ายังไม่ผ่านค่อย fallback ยิงทีละตัวแทน
 * เพื่อไม่ให้ request เดียวทำทั้ง sync ล้มไปด้วย)
 *************************************************/

function makeFailedResponse_(message) {

  return {

    getResponseCode: function() {

      return -1;

    },

    getContentText: function() {

      return '';

    },

    _error: message

  };

}



function fetchAllWithRetry_(
  requests,
  maxRetries
) {

  for (
    let attempt = 1;
    attempt <= maxRetries;
    attempt++
  ) {

    try {

      return UrlFetchApp.fetchAll(
        requests
      );

    } catch (e) {

      Logger.log(
        'fetchAll ล้มเหลว (ครั้งที่ ' +
        attempt + '/' + maxRetries +
        '): ' + e.message
      );

      if (attempt < maxRetries) {

        Utilities.sleep(
          1000 * attempt
        );

      }

    }

  }


  Logger.log(
    'fetchAll ล้มเหลวซ้ำ ' +
    maxRetries +
    ' ครั้ง — ยิงทีละตัวแทนสำหรับชุดนี้'
  );


  return requests.map(function(req) {

    try {

      return UrlFetchApp.fetch(
        req.url,
        req
      );

    } catch (e) {

      return makeFailedResponse_(
        e.message
      );

    }

  });

}



/*************************************************
 * SCRIPT PROPERTY JSON HELPERS
 * (เก็บ progress ไว้ resume ข้ามการรัน — เหมาะกับ
 * ข้อมูลไม่กี่พันรายการ เพราะ Script Property
 * แต่ละตัวมี limit ~9KB)
 *************************************************/

function readJsonProp_(props, key) {

  const raw =
    props.getProperty(key);

  if (!raw) {

    return null;

  }

  return JSON.parse(raw);

}



function writeJsonProp_(props, key, value) {

  props.setProperty(
    key,
    JSON.stringify(value)
  );

}



/*************************************************
 * RESET SYNC STATE
 * (ล้าง progress ที่ syncRocket75 ค้างไว้ทั้งหมด
 * รอบถัดไปจะเริ่มนับ parent/sub ticket ใหม่หมด
 * ไม่กระทบข้อมูลที่เขียนลงชีท Tickets/Parts ไปแล้ว
 * เพราะ batchUpsertTickets_ เป็น upsert ตาม
 * Ticket ID อยู่แล้ว รันซ้ำจะแค่ทับข้อมูลเดิมด้วย
 * ค่าล่าสุด ไม่สร้างแถวซ้ำ)
 *************************************************/

function resetSyncState() {

  const props =
    PropertiesService
      .getScriptProperties();


  props.deleteProperty('SYNC_PARENT_IDS');
  props.deleteProperty('SYNC_PENDING_PARENTS');
  props.deleteProperty('SYNC_SUB_IDS');
  props.deleteProperty('SYNC_PENDING_SUBS');


  Logger.log(
    'ล้าง sync state แล้ว ' +
    'รัน syncRocket75 รอบถัดไปจะเริ่มนับ parent/sub ' +
    'ticket ใหม่ทั้งหมด (ข้อมูลในชีท Tickets/Parts ' +
    'ที่เขียนไปแล้วยังอยู่ครบ ไม่ถูกลบ)'
  );

}



/*************************************************
 * CLEAR SHEET DATA — ลบข้อมูลจริงถาวร!
 * (แยกจาก resetSyncState() โดยตั้งใจ เพราะเป็นคน
 * ละระดับความเสี่ยงกัน — ตัวนี้ลบแถวข้อมูลใน
 * Tickets ทิ้งจริง เหลือแค่ header กู้คืนได้
 * แค่ผ่าน Version History ของ Sheets เท่านั้น
 * ใช้ตอนต้องการเริ่มข้อมูลใหม่ทั้งหมดจริงๆ เช่น
 * ทดสอบ parser ใหม่แล้วอยาก sync ซ้ำแบบสะอาด
 * ควรรัน resetSyncState() คู่กันด้วยเสมอ ไม่งั้น
 * sync รอบถัดไปอาจ resume แบบข้อมูลไม่ครบช่วง)
 *************************************************/

function clearSheetData() {

  const ss =
    SpreadsheetApp
      .getActiveSpreadsheet();


  [
    ROCKET.TICKET_SHEET
  ].forEach(function(sheetName) {

    const sheet =
      ss.getSheetByName(sheetName);

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
      sheetName +
      '" แล้ว (เหลือแค่ header)'
    );

  });


  Logger.log(
    'เสร็จ — ถ้าจะ sync ใหม่ทั้งหมดให้รัน ' +
    'resetSyncState() ด้วย ก่อนรัน syncRocket75'
  );

}



/*************************************************
 * LOGIN
 *************************************************/

function rocketLogin_() {

  const props =
    PropertiesService
      .getScriptProperties();


  const username =
    props.getProperty(
      'ROCKET_USERNAME'
    );


  const password =
    props.getProperty(
      'ROCKET_PASSWORD'
    );


  if (!username || !password) {

    throw new Error(
      'ยังไม่ได้ตั้ง ROCKET_USERNAME / ROCKET_PASSWORD'
    );

  }


  const loginPage =
    ROCKET.BASE + '/index.php';


  const authUrl =
    ROCKET.BASE + '/auth.php';


  // ==========================================
  // เปิดหน้า Login ก่อนเพื่อสร้าง PHPSESSID
  // ==========================================

  const firstRes =
    UrlFetchApp.fetch(
      loginPage,
      {

        method: 'get',

        followRedirects: false,

        muteHttpExceptions: true

      }
    );


  let cookie =
    extractPhpSession_(firstRes);


  // ==========================================
  // POST LOGIN
  // ==========================================

  const headers = {

    'Origin':
      ROCKET.BASE,

    'Referer':
      loginPage,

    'Accept':
      'application/json, text/javascript, */*; q=0.01',

    'X-Requested-With':
      'XMLHttpRequest'

  };


  if (cookie) {

    headers.Cookie =
      cookie;

  }


  const loginRes =
    UrlFetchApp.fetch(
      authUrl,
      {

        method: 'post',

        payload: {

          username:
            username,

          password:
            password

        },

        headers:
          headers,

        followRedirects:
          false,

        muteHttpExceptions:
          true

      }
    );


  const http =
    loginRes.getResponseCode();


  if (http !== 200) {

    throw new Error(
      'Login HTTP ' +
      http
    );

  }


  // Server อาจเปลี่ยน PHPSESSID
  const newCookie =
    extractPhpSession_(
      loginRes
    );


  if (newCookie) {

    cookie =
      newCookie;

  }


  const body =
    loginRes
      .getContentText(
        'UTF-8'
      );


  let data;


  try {

    data =
      JSON.parse(body);

  } catch (e) {

    throw new Error(
      'auth.php ไม่ได้คืน JSON: ' +
      body.substring(
        0,
        500
      )
    );

  }


  const sing =
    Number(
      data.sing
    );


  if (sing === 0) {

    throw new Error(
      'Username หรือ Password ไม่ถูกต้อง'
    );

  }


  if (sing === 2) {

    throw new Error(
      'บัญชีต้องเปลี่ยน Password ก่อน'
    );

  }


  if (sing === 3) {

    throw new Error(
      'บัญชีถูกจำกัด กรุณาติดต่อผู้ดูแล'
    );

  }


  if (
    sing !== 1 ||
    !data.token ||
    !data.key
  ) {

    throw new Error(
      'Login ไม่สำเร็จ'
    );

  }


  // Proxy หน้าเว็บบางตัว strip header Set-Cookie ทิ้งหมด
  // เลยให้ auth.php ส่ง PHPSESSID มาทาง JSON body แทนเป็นทางสำรอง (ถ้ามี)
  if (!cookie && data.PHPSESSID) {

    cookie =
      'PHPSESSID=' +
      data.PHPSESSID;

  }


  // AJAX ของ Rocket75 ใช้ token/key เป็นหลัก ไม่ได้บังคับ PHPSESSID
  // ถ้าไม่มี cookie ก็ปล่อยผ่าน ให้ทุก request ที่ตามมาไม่แนบ Cookie header
  Logger.log(
    'COOKIE = ' +
    (cookie ? 'YES' : 'NO')
  );


  return {

    cookie:
      cookie || '',

    token:
      data.token,

    key:
      data.key

  };

}



/*************************************************
 * GET PHP SESSION
 *************************************************/

function extractPhpSession_(response) {

  const headers =
    response
      .getAllHeaders();


  let setCookie =
    headers['Set-Cookie'] ||
    headers['set-cookie'];


  if (!setCookie) {

    return '';

  }


  if (
    Array.isArray(
      setCookie
    )
  ) {

    setCookie =
      setCookie.join('; ');

  }


  const m =
    String(
      setCookie
    ).match(
      /PHPSESSID=([^;]+)/i
    );


  if (!m) {

    return '';

  }


  return (
    'PHPSESSID=' +
    m[1]
  );

}



/*************************************************
 * GET PARENT TICKET TABLE
 *************************************************/

function getParentTicketHtml_(
  auth,
  startDate,
  endDate
) {

  const url =
    ROCKET.BASE +
    '/main/ajax/ticket/getTable.php';


  const headers = {

    Origin:
      ROCKET.BASE,

    Referer:
      ROCKET.BASE +
      '/main/ticket_list.php',

    'X-Requested-With':
      'XMLHttpRequest'

  };


  if (auth.cookie) {

    headers.Cookie =
      auth.cookie;

  }


  const res =
    UrlFetchApp.fetch(
      url,
      {

        method:
          'post',

        payload: {

          status:
            '',

          start_date:
            startDate,

          end_date:
            endDate,

          search_checkrepair:
            'x',

          name_search:
            '',

          search_team:
            'x',

          search_staff:
            'x',

          token:
            auth.token,

          key:
            auth.key,

          search_type:
            'x',

          search_area:
            'x',

          // 1 = วันที่สร้าง
          date_type:
            '1',

          search_warranty_type:
            'x'

        },

        headers:
          headers,

        muteHttpExceptions:
          true

      }
    );


  if (
    res.getResponseCode()
    !== 200
  ) {

    throw new Error(
      'getTable.php HTTP ' +
      res.getResponseCode()
    );

  }


  return res
    .getContentText(
      'UTF-8'
    );

}



/*************************************************
 * EXTRACT PARENT IDS
 *************************************************/

function extractParentTicketIds_(html) {

  const ids = [];

  const regex =
    /ticket_view\.php\?id=(\d+)/gi;


  let m;


  while (
    (m = regex.exec(html))
    !== null
  ) {

    ids.push(
      m[1]
    );

  }


  return [
    ...new Set(ids)
  ];

}



/*************************************************
 * GET SUB TICKETS
 *************************************************/

function buildCheckRepairRequest_(
  parentTicketId,
  auth
) {

  const headers = {

    Origin:
      ROCKET.BASE,

    Referer:
      ROCKET.BASE +
      '/main/ticket_view.php?id=' +
      parentTicketId,

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
      '/main/ajax/ticket_view/checkrepair.php',

    method:
      'post',

    payload: {

      ticket_id:
        String(
          parentTicketId
        ),

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



function getCheckRepair_(
  parentTicketId,
  auth
) {

  const request =
    buildCheckRepairRequest_(
      parentTicketId,
      auth
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
      'checkrepair.php HTTP ' +
      res.getResponseCode()
    );

  }


  return res
    .getContentText(
      'UTF-8'
    );

}



/*************************************************
 * EXTRACT SUB TICKET IDS
 *************************************************/

function extractCheckRepairIds_(html) {

  const ids = [];


  const regex =
    /ticket_checkrepair_view\.php\?id=(\d+)/gi;


  let m;


  while (
    (m = regex.exec(html))
    !== null
  ) {

    ids.push(
      m[1]
    );

  }


  return [
    ...new Set(ids)
  ];

}



/*************************************************
 * GET SUB TICKET DETAIL
 *************************************************/

function buildTicketDetailRequest_(
  ticketId,
  auth
) {

  const headers = {

    Referer:
      ROCKET.BASE +
      '/main/'

  };


  if (auth.cookie) {

    headers.Cookie =
      auth.cookie;

  }


  return {

    url:
      ROCKET.BASE +
      '/main/ticket_checkrepair_view.php?id=' +
      ticketId,

    method:
      'get',

    headers:
      headers,

    followRedirects:
      true,

    muteHttpExceptions:
      true

  };

}



function getTicketDetailHtml_(
  ticketId,
  auth
) {

  const request =
    buildTicketDetailRequest_(
      ticketId,
      auth
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
      'Ticket Detail HTTP ' +
      res.getResponseCode()
    );

  }


  return res
    .getContentText(
      'UTF-8'
    );

}



/*************************************************
 * PARSE TICKET DETAIL
 *************************************************/

function parseTicketDetail_(
  html,
  ticketId
) {

  const ticketNo =
    extractRegex_(
      html,
      /<h1[^>]*>[\s\S]*?([A-Z]+[A-Z0-9-]+\.R\d+)[\s\S]*?<\/h1>/i
    ) ||
    extractRegex_(
      html,
      /(BK[A-Z0-9-]+\.R\d+)/i
    );


  const parentId =
    extractRegex_(
      html,
      /ticket_view\.php\?id=(\d+)/i
    );


  const parentTicketNo =
    cleanText_(
      extractRegex_(
        html,
        /<a\s+href=["']ticket_view\.php\?id=\d+["'][^>]*>([\s\S]*?)<\/a>/i
      )
    ).replace(
      /^\/\s*/,
      ''
    );


  const appointment =
    extractBeforeLabel_(
      html,
      'เวลานัดหมาย'
    );


  const status =
    extractRegex_(
      html,
      /d-flex align-items-center mb-1[\s\S]*?<span[^>]*class=["'][^"']*badge[^"']*["'][^>]*>([\s\S]*?)<\/span>/i
    );


  return {

    ticketId:
      ticketId,

    parentTicketId:
      parentId,

    parentTicketNo:
      parentTicketNo,

    ticketNo:
      cleanText_(
        ticketNo
      ),

    status:
      cleanText_(
        status
      ),

    appointment:
      cleanText_(
        appointment
      ),


    reportDate:
      getDtValue_(
        html,
        'วันที่แจ้ง'
      ),

    customer:
      getDtValue_(
        html,
        'ลูกค้า'
      ),

    branch:
      getDtValue_(
        html,
        'สาขา'
      ),

    contact:
      getDtValue_(
        html,
        'ผู้ติดต่อ'
      ),

    phone:
      getDtValue_(
        html,
        'เบอร์โทร'
      ),

    problem:
      getDtValue_(
        html,
        'อาการเสีย'
      ),

    workDescription:
      getDtValue_(
        html,
        'คำอธิบายงาน'
      ),

    specialCondition:
      getDtValue_(
        html,
        'เงื่อนไข/อุปกรณ์พิเศษ'
      ),

    note:
      getDtValue_(
        html,
        'หมายเหตุ'
      ),

    machineLocation:
      getDtValue_(
        html,
        'ที่อยู่ปัจจุบันของเครื่อง'
      ),


    productCode:
      getDtValue_(
        html,
        'รหัสรุ่น'
      ),

    productName:
      getDtValue_(
        html,
        'ชื่อรุ่น'
      ),

    powerType:
      getDtValue_(
        html,
        'ประเภท'
      ),

    serial:
      getDtValue_(
        html,
        'Serial'
      ),

    warranty:
      getDtValue_(
        html,
        'ประกัน'
      ),


    startTime:
      getH5Value_(
        html,
        'เวลาเข้างาน'
      ),

    endTime:
      getH5Value_(
        html,
        'เวลาเสร็จงาน'
      ),

    duration:
      getH5Value_(
        html,
        'เวลาที่ใช้ (นาที)'
      ),

    timeRecorder:
      getH5Value_(
        html,
        'ผู้บันทึกเวลา'
      ),


    repairResult:
      getH5Value_(
        html,
        'ผลการซ่อม'
      ),

    customerSymptom:
      getH5Value_(
        html,
        'อาการเสียจากลูกค้า'
      ),

    causeFound:
      getH5Value_(
        html,
        'หมายเหตุที่พบ'
      ),

    solution:
      getH5Value_(
        html,
        'การแก้ไข'
      ),

    repairNote:
      getH5Value_(
        html,
        'บันทึกการซ่อม'
      ),

    partFailureCause:
      getH5Value_(
        html,
        'สาเหตุการชำรุดของอะไหล่'
      ),

    technician:
      getH5Value_(
        html,
        'ช่างเทคนิค'
      ),


    url:
      ROCKET.BASE +
      '/main/ticket_checkrepair_view.php?id=' +
      ticketId,

    lastSync:
      new Date()

  };

}



/*************************************************
 * HTML HELPERS
 *************************************************/

function getDtValue_(
  html,
  label
) {

  const escaped =
    escapeRegex_(label);


  const regex =
    new RegExp(
      '<dt[^>]*>\\s*' +
      escaped +
      '\\s*:?\\s*<\\/dt>' +
      '[\\s\\S]*?' +
      '<dd[^>]*>' +
      '([\\s\\S]*?)' +
      '<\\/dd>',
      'i'
    );


  const m =
    html.match(regex);


  return m
    ? cleanText_(m[1])
    : '';

}



function getH5Value_(
  html,
  label
) {

  const escaped =
    escapeRegex_(label);


  const regex =
    new RegExp(
      '<h5[^>]*>\\s*' +
      escaped +
      '\\s*<\\/h5>' +
      '[\\s\\S]*?' +
      '<(?:label|div)[^>]*>' +
      '([\\s\\S]*?)' +
      '<\\/(?:label|div)>',
      'i'
    );


  const m =
    html.match(regex);


  return m
    ? cleanText_(m[1])
    : '';

}



function extractBeforeLabel_(
  html,
  label
) {

  const escaped =
    escapeRegex_(label);


  const regex =
    new RegExp(
      '<div[^>]*class=["\'][^"\']*fs-4[^"\']*["\'][^>]*>' +
      '([\\s\\S]*?)' +
      '<\\/div>' +
      '[\\s\\S]*?' +
      escaped,
      'i'
    );


  const m =
    html.match(regex);


  return m
    ? cleanText_(m[1])
    : '';

}



function extractRegex_(
  text,
  regex
) {

  const m =
    text.match(regex);


  if (!m) {

    return '';

  }


  return m[1] || '';

}



function cleanText_(html) {

  if (
    html === null ||
    html === undefined
  ) {

    return '';

  }


  return String(html)

    .replace(
      /<script[\s\S]*?<\/script>/gi,
      ' '
    )

    .replace(
      /<style[\s\S]*?<\/style>/gi,
      ' '
    )

    .replace(
      /<br\s*\/?>/gi,
      '\n'
    )

    .replace(
      /<[^>]+>/g,
      ' '
    )

    .replace(
      /&nbsp;/gi,
      ' '
    )

    .replace(
      /&amp;/gi,
      '&'
    )

    .replace(
      /&quot;/gi,
      '"'
    )

    .replace(
      /&#039;/gi,
      "'"
    )

    .replace(
      /&lt;/gi,
      '<'
    )

    .replace(
      /&gt;/gi,
      '>'
    )

    .replace(
      /[ \t]+/g,
      ' '
    )

    .replace(
      /\s*\n\s*/g,
      '\n'
    )

    .trim();

}



function escapeRegex_(text) {

  return String(text)
    .replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&'
    );

}



/*************************************************
 * WRITE TICKETS SHEET (batch — สร้าง index ID
 * ครั้งเดียวต่อการรัน แทนที่จะอ่านทั้งคอลัมน์ใหม่
 * ทุก ticket แบบเดิม ซึ่งช้าลงเรื่อยๆ แบบ O(n²)
 * เมื่อข้อมูลในชีทเยอะขึ้น)
 *************************************************/

const TICKET_HEADERS_ = [

  'Ticket ID',
  'Parent Ticket ID',
  'Parent Ticket No',
  'Ticket No',
  'Status',
  'Appointment',

  'Report Date',
  'Customer',
  'Branch',
  'Contact',
  'Phone',

  'Problem Reported',
  'Work Description',
  'Special Condition',
  'Note',
  'Machine Location',

  'Product Code',
  'Product Name',
  'Power Type',
  'Serial',
  'Warranty',

  'Start Time',
  'End Time',
  'Duration Min',
  'Time Recorder',

  'Repair Result',
  'Customer Symptom',
  'Cause Found',
  'Solution',
  'Repair Note',
  'Part Failure Cause',
  'Technician',

  'URL',
  'Last Sync'

];



function columnLetter_(n) {

  let letters = '';


  while (n > 0) {

    const rem =
      (n - 1) % 26;

    letters =
      String.fromCharCode(65 + rem) +
      letters;

    n =
      Math.floor((n - 1) / 26);

  }


  return letters;

}



function formatDateForSheet_(date) {

  return Utilities.formatDate(
    date,
    Session.getScriptTimeZone(),
    'dd/MM/yyyy HH:mm:ss'
  );

}



// valueInputOption: 'USER_ENTERED' ตีความค่าที่เป็น
// ตัวเลขล้วนๆ เป็น number ทำให้เลข 0 นำหน้าหาย (เช่น
// เบอร์โทร) เติม ' นำหน้าบังคับให้เป็น text เสมอ
function forceTextIfNumeric_(value) {

  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {

    return value;

  }


  const str =
    String(value);


  if (/^\d+$/.test(str)) {

    return "'" + str;

  }


  return str;

}



function buildTicketRowIndex_() {

  const ss =
    SpreadsheetApp
      .getActiveSpreadsheet();


  let sheet =
    ss.getSheetByName(
      ROCKET.TICKET_SHEET
    );


  if (!sheet) {

    sheet =
      ss.insertSheet(
        ROCKET.TICKET_SHEET
      );

  }


  // เขียน header ทับทุกครั้ง (ไม่ใช่แค่ตอนชีทว่าง)
  // กันปัญหา schema เปลี่ยน (เพิ่ม/ลบคอลัมน์) แล้ว
  // header แถวบนค้างเป็นชื่อเก่า ทำให้เพี้ยนกับข้อมูล
  // จริงที่เขียนแบบ column ใหม่
  sheet.getRange(
    1,
    1,
    1,
    TICKET_HEADERS_.length
  ).setValues(
    [TICKET_HEADERS_]
  );


  const index = {};

  const lastRow =
    sheet.getLastRow();


  if (lastRow >= 2) {

    const ids =
      sheet.getRange(
        2,
        1,
        lastRow - 1,
        1
      )
      .getDisplayValues();

    ids.forEach(function(row, i) {

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



function ticketToRow_(d) {

  return [

    d.ticketId,
    d.parentTicketId,
    d.parentTicketNo,
    d.ticketNo,
    d.status,
    d.appointment,

    d.reportDate,
    d.customer,
    d.branch,
    d.contact,
    forceTextIfNumeric_(d.phone),

    d.problem,
    d.workDescription,
    d.specialCondition,
    d.note,
    d.machineLocation,

    d.productCode,
    d.productName,
    d.powerType,
    d.serial,
    d.warranty,

    d.startTime,
    d.endTime,
    d.duration,
    d.timeRecorder,

    d.repairResult,
    d.customerSymptom,
    d.causeFound,
    d.solution,
    d.repairNote,
    d.partFailureCause,
    d.technician,

    d.url,
    formatDateForSheet_(d.lastSync)

  ];

}



/*************************************************
 * เขียน Tickets แบบ batch เดียวต่อทั้ง chunk ผ่าน
 * Advanced Sheets Service (Sheets.Spreadsheets
 * .Values.batchUpdate) แทนที่จะยิง setValues()
 * แยกทีละ ticket — ต้องเปิด Advanced Google
 * Services > Google Sheets API ในโปรเจกต์ก่อน
 *************************************************/

function batchUpsertTickets_(
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
      TICKET_HEADERS_.length
    );

  const data = [];

  const newRows = [];


  tickets.forEach(function(d) {

    const row =
      ticketToRow_(d);

    const existingRow =
      ctx.index[String(d.ticketId)];


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

        ticketId: d.ticketId,
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

      ctx.index[String(r.ticketId)] =
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



/*************************************************
 * TEST LOGIN ONLY
 *************************************************/

function testRocketLogin() {

  const auth =
    rocketLogin_();


  Logger.log(
    'LOGIN OK'
  );


  Logger.log(
    'COOKIE = ' +
    Boolean(
      auth.cookie
    )
  );


  Logger.log(
    'TOKEN = ' +
    Boolean(
      auth.token
    )
  );


  Logger.log(
    'KEY = ' +
    Boolean(
      auth.key
    )
  );

}



/*************************************************
 * TEST PARENT IDS ONLY
 *************************************************/

function testParentTickets() {

  const auth =
    rocketLogin_();


  const html =
    getParentTicketHtml_(
      auth,
      ROCKET.START_DATE,
      ROCKET.END_DATE
    );


  const ids =
    extractParentTicketIds_(
      html
    );


  Logger.log(
    'FOUND PARENT: ' +
    ids.length
  );


  ids.forEach(
    function(id) {

      Logger.log(id);

    }
  );

}



/*************************************************
 * TEST ONE KNOWN PARENT
 *************************************************/

function testOneParent() {

  const auth =
    rocketLogin_();


  const parentId =
    '1977310227';


  const html =
    getCheckRepair_(
      parentId,
      auth
    );


  const ids =
    extractCheckRepairIds_(
      html
    );


  Logger.log(
    ids
  );

}



/*************************************************
 * TEST ONE KNOWN SUB TICKET
 *************************************************/

function testOneSubTicket() {

  const auth =
    rocketLogin_();


  const id =
    '9222470960';


  const html =
    getTicketDetailHtml_(
      id,
      auth
    );


  const ticket =
    parseTicketDetail_(
      html,
      id
    );


  Logger.log(
    JSON.stringify(
      ticket,
      null,
      2
    )
  );

}



/*************************************************
 * TEST FIND OLDEST TICKET DATE
 * (ใช้ครั้งเดียวเพื่อหาว่าควรตั้ง START_DATE
 * ของการ sync ย้อนหลังไว้ที่วันไหน)
 *
 * ช่วงกว้างเกินไป (เช่นยิงทีเดียว 16 ปี) ทำให้ฝั่ง
 * เซิร์ฟเวอร์ต้อง render ข้อมูลมหาศาลจนค้าง/timeout
 * ฟังก์ชันนี้เลยไล่ทีละเดือนแทน (เบากว่ามาก) และ
 * บันทึกความคืบหน้าไว้ใน Script Properties เพื่อ
 * รันซ้ำแล้ว "ต่อ" จากเดือนที่ค้างไว้ได้ ไม่ต้องเริ่มใหม่
 *************************************************/

function testFindOldestTickets() {

  const auth =
    rocketLogin_();


  const props =
    PropertiesService
      .getScriptProperties();


  let year =
    Number(
      props.getProperty('SCAN_YEAR')
    ) ||
    2026;

  let month =
    Number(
      props.getProperty('SCAN_MONTH')
    ) ||
    8;


  const startedAt =
    new Date();

  // เผื่อเวลาไว้ ไม่ให้ชน 6 นาทีของ Apps Script
  const maxRunMs =
    4.5 * 60 * 1000;


  for (
    let i = 0;
    i < 240;
    i++
  ) {

    if (
      (new Date() - startedAt)
      > maxRunMs
    ) {

      props.setProperty(
        'SCAN_YEAR',
        String(year)
      );

      props.setProperty(
        'SCAN_MONTH',
        String(month)
      );

      Logger.log(
        'ใกล้ timeout แล้ว หยุดไว้ที่ ' +
        year + '-' + pad2_(month) +
        ' — กด "เรียกใช้" testFindOldestTickets อีกครั้ง ' +
        'เพื่อสแกนต่อจากเดือนนี้'
      );

      return;

    }


    const startDate =
      '01/' + pad2_(month) + '/' + year;

    const lastDay =
      daysInMonth_(year, month);

    const endDate =
      pad2_(lastDay) + '/' + pad2_(month) + '/' + year;

    const html =
      getParentTicketHtml_(
        auth,
        startDate,
        endDate
      );

    const ids =
      extractParentTicketIds_(html);

    Logger.log(
      year + '-' + pad2_(month) +
      ' : ' +
      ids.length +
      ' parent tickets'
    );


    if (ids.length === 0) {

      Logger.log(
        'เจอเดือนที่ไม่มี ticket เลยที่ ' +
        year + '-' + pad2_(month) +
        ' — ลองเช็คย้อนอีก 2-3 เดือนก่อนหน้าเพื่อความชัวร์ ' +
        'ว่าไม่ใช่แค่เดือนที่บังเอิญไม่มีงาน'
      );

      props.deleteProperty('SCAN_YEAR');
      props.deleteProperty('SCAN_MONTH');

      return;

    }


    month--;

    if (month === 0) {

      month = 12;
      year--;

    }

  }

}



function pad2_(n) {

  return (
    n < 10 ?
    '0' + n :
    String(n)
  );

}



function daysInMonth_(year, month) {

  return new Date(
    year,
    month,
    0
  ).getDate();

}



/*************************************************
 * TEST INSPECT PHOTO/VIDEO STRUCTURE
 * (ใช้ครั้งเดียวเพื่อดูโครงสร้าง HTML จริงของ
 * รูป/วิดีโอในหน้า ticket detail ก่อนเขียนตัวดึงจริง)
 *************************************************/

function testInspectPhotos() {

  const auth =
    rocketLogin_();


  const id =
    '9222470960';


  const html =
    getTicketDetailHtml_(
      id,
      auth
    );


  Logger.log(
    'HTML length: ' +
    html.length
  );


  // ==========================================
  // IMG TAGS
  // ==========================================

  const imgRegex =
    /<img\b[^>]*>/gi;

  let m;
  let imgCount = 0;


  while (
    (m = imgRegex.exec(html)) !== null &&
    imgCount < 40
  ) {

    const start =
      Math.max(
        0,
        m.index - 250
      );

    const context =
      html.substring(
        start,
        m.index + m[0].length
      );

    Logger.log(
      '--- IMG #' +
      (imgCount + 1) +
      ' ---\n' +
      context
        .replace(/\s+/g, ' ')
        .trim()
    );

    imgCount++;

  }


  if (imgCount === 0) {

    Logger.log(
      'ไม่เจอ <img> เลยในหน้านี้'
    );

  }


  // ==========================================
  // VIDEO / SOURCE TAGS
  // ==========================================

  const videoRegex =
    /<video\b[\s\S]*?<\/video>|<source\b[^>]*>/gi;

  let vCount = 0;


  while (
    (m = videoRegex.exec(html)) !== null &&
    vCount < 20
  ) {

    const start =
      Math.max(
        0,
        m.index - 250
      );

    const context =
      html.substring(
        start,
        m.index + m[0].length
      );

    Logger.log(
      '--- VIDEO #' +
      (vCount + 1) +
      ' ---\n' +
      context
        .replace(/\s+/g, ' ')
        .trim()
    );

    vCount++;

  }


  if (vCount === 0) {

    Logger.log(
      'ไม่เจอ <video>/<source> เลยในหน้านี้ ' +
      '(อาจไม่มีวิดีโอใน ticket นี้ หรือโหลดผ่าน JS/ajax แยก)'
    );

  }

}