/*************************************************
 * ROCKET75 → GOOGLE SHEETS — TICKET STAGE OVERVIEW
 * (ยังอยู่ระหว่าง inspect โครงสร้างจริง — ยังไม่เขียน
 * sync/parser จริง)
 *
 * เป้าหมาย: รายงานว่าแต่ละ "เลขที่งาน" (parent
 * ticket) ตอนนี้อยู่ stage ไหนใน pipeline 10 ขั้น
 * (1 = คอลเซ็นเตอร์/ออกเลขที่งาน ... 10 = บัญชี)
 *
 * สมมติฐานที่ต้อง verify ก่อน: แท็บ "ภาพรวม" ที่เห็น
 * ในหน้า ticket_view.php น่าจะเป็นแท็บ default ที่โหลด
 * มาพร้อมหน้าแรกเลย (ไม่ต้องกด AJAX แยกเหมือนแท็บ
 * "ตรวจเช็ค/เข้าซ่อม") ถ้าใช่ แปลว่า GET ธรรมดาไปที่
 * ticket_view.php?id=X ก็น่าจะมีข้อมูล stage/สถานะ
 * ของทุกขั้นตอนอยู่ในนั้นแล้ว ไม่ต้องยิง request แยก
 * ทีละแท็บ (10 request/ticket) ซึ่งจะช้ามาก
 *************************************************/

function testInspectTicketOverview() {

  const auth =
    rocketLogin_();


  const parentId =
    '7368650230';


  const url =
    ROCKET.BASE +
    '/main/ticket_view.php?id=' +
    parentId;


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


  // รอบแรกที่ค้นด้วย keyword พวกนี้ ดันไปเจอแค่เมนู
  // sidebar ทั่วไปของระบบ (ลิงก์ report_xxx.php,
  // spare_part_xxx.php ฯลฯ) ไม่ใช่แท็บของ ticket จริง —
  // รอบนี้หาทุกตำแหน่งที่เจอ (ไม่ใช่แค่ตำแหน่งแรก) แล้ว
  // ลองยึดจากเลขที่ ticket เองแทน เพราะเป็นข้อความที่
  // ควรจะไม่ซ้ำและอยู่ในส่วนเนื้อหาจริงของหน้าเท่านั้น
  function findAll_(needle) {

    const positions = [];

    let fromIndex = 0;

    let idx;


    while (
      (idx = html.indexOf(needle, fromIndex))
      !== -1
    ) {

      positions.push(idx);

      fromIndex =
        idx + 1;

    }


    return positions;

  }


  const keywords = [

    'BKRM0826-000544',
    'ตรวจงานแล้ว',
    'ภาพรวม',
    'คอลเซ็นเตอร์',
    'ติดตามใบเสนอราคา',
    'หัวหน้าธุรการ',
    'ธุรการเปิดบิล',
    'บันทึกประจำวัน'

  ];


  let ticketContentStart = null;


  keywords.forEach(function(keyword) {

    const positions =
      findAll_(keyword);

    Logger.log(
      'พบ "' +
      keyword +
      '" (' +
      positions.length +
      ' ครั้ง) ที่ตำแหน่ง: ' +
      positions.join(', ')
    );


    if (
      keyword === 'BKRM0826-000544' &&
      positions.length > 0
    ) {

      ticketContentStart =
        positions[0];

    }

  });


  if (ticketContentStart !== null) {

    const start =
      ticketContentStart;

    const end =
      Math.min(
        html.length,
        ticketContentStart + 6000
      );

    Logger.log(
      'AROUND TICKET NUMBER (เนื้อหาจริงของ ticket ' +
      'ควรเริ่มแถวนี้):\n' +
      html
        .substring(start, end)
        .replace(/></g, '>\n<')
    );

  } else {

    Logger.log(
      'ไม่เจอเลขที่ ticket ในหน้านี้เลย — ผิดปกติ ' +
      'ต้องเช็คว่า login/parentId ถูกต้องไหม'
    );

  }


  // จากรอบก่อน: keyword ชื่อแท็บทั้งหมด (ภาพรวม,
  // คอลเซ็นเตอร์, ติดตามใบเสนอราคา, หัวหน้าธุรการ,
  // ธุรการเปิดบิล, บันทึกประจำวัน) กระจุกตัวกันอยู่
  // แถวๆ ตำแหน่ง 114000-118000 พอดี — ตรงกับแท็บบาร์
  // ที่เห็นในสกรีนช็อต ลอง dump ทั้งช่วงดูว่ามี badge/
  // class บอกสถานะ (เสร็จ/กำลังทำ/ยังไม่ถึง) ติดมาด้วย
  // ในแต่ละแท็บไหม
  Logger.log(
    'TAB BAR SECTION (113000-119000):\n' +
    html
      .substring(113000, 119000)
      .replace(/></g, '>\n<')
  );


  // แต่ละแท็บมี id ลงท้ายด้วย "Count" (CCCount,
  // CRCount, WDCount, ...) และ <div class="tab-pane">
  // ของทุกแท็บว่างเปล่าตอนโหลดหน้าแรก — แปลว่าเนื้อหา
  // ต้องโหลดผ่าน AJAX ทีหลัง (เหมือนแท็บ ตรวจเช็ค/
  // เข้าซ่อม ที่รู้จักอยู่แล้ว) หา occurrence อื่นของ
  // "CCCount" ที่ไม่ใช่ตัว id ในแท็บ (น่าจะอยู่ใน
  // <script> ที่ยิง ajax มาเติมเลขนับ) เพื่อดูว่ามี
  // endpoint เดียวที่ให้ข้อมูลทุกแท็บพร้อมกันไหม
  const ccPositions =
    findAll_('CCCount');

  Logger.log(
    'CCCount ปรากฏที่: ' +
    ccPositions.join(', ')
  );


  ccPositions.forEach(function(pos, i) {

    if (i === 0) {

      return;

    }


    const start =
      Math.max(0, pos - 600);

    const end =
      Math.min(html.length, pos + 600);

    Logger.log(
      'AROUND CCCount OCCURRENCE #' +
      (i + 1) +
      ':\n' +
      html
        .substring(start, end)
        .replace(/></g, '>\n<')
    );

  });


  // occurrence #2 (158431) คือใน callback ที่ได้รับ
  // "response" มา — หา $.ajax(/$.post(/fetch( ที่ยิง
  // ไปสร้าง response ตัวนี้ โดยดูโค้ดก่อนหน้าตำแหน่ง
  // นั้นในบล็อก <script> เดียวกัน (URL ควรอยู่ก่อน
  // callback success ไม่ไกลนัก)
  if (ccPositions.length >= 2) {

    const secondPos =
      ccPositions[1];

    const start =
      Math.max(
        0,
        secondPos - 3000
      );

    Logger.log(
      'CODE BEFORE CCCount OCCURRENCE #2 ' +
      '(หา url ของ ajax call):\n' +
      html
        .substring(start, secondPos)
    );

  }

}



/*************************************************
 * CHKTICKET ENDPOINT
 * (เจอจาก inline <script> ในหน้า ticket_view.php:
 *   $.ajax({ url: "ajax/ticket_view/ChkTicket.php",
 *     data: { token, key, ticket_id } })
 * response.ticketXX > 0 หมายถึงมีงานค้างอยู่ใน
 * stage นั้น — 1 request ต่อ 1 parent ticket ได้
 * ครบทุก stage เลย ไม่ต้องยิงทีละแท็บ (10 ต่อ 1
 * ticket) เหมือนที่กังวลไว้ตอนแรก
 *************************************************/

function buildChkTicketRequest_(
  parentId,
  auth
) {

  return {

    url:
      ROCKET.BASE +
      '/main/ajax/ticket_view/ChkTicket.php',

    method:
      'post',

    payload: {

      token:
        auth.token,

      key:
        auth.key,

      ticket_id:
        String(parentId)

    },

    muteHttpExceptions:
      true

  };

}



function testChkTicket() {

  const auth =
    rocketLogin_();


  const parentId =
    '7368650230';


  const request =
    buildChkTicketRequest_(
      parentId,
      auth
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


  const text =
    res.getContentText('UTF-8');

  Logger.log(
    'RAW RESPONSE:\n' +
    text
  );

}



/*************************************************
 * ChkTicket.php ต้องการ parent ticket_id (ตัวที่ใช้
 * ใน ticket_view.php?id=X) ไม่ใช่ sub ticket id
 * (ที่ใช้ใน ticket_checkrepair_view.php?id=X) —
 * ฟังก์ชันนี้รับ sub ticket id มา หา parent ให้ก่อน
 * แล้วค่อยยิง ChkTicket.php (ใช้ getTicketDetailHtml_
 * และ parseTicketDetail_ ที่มีอยู่แล้วใน appscript.js
 * เพื่อดึง parentTicketId + status ของ sub ticket นี้
 * มาโชว์เทียบกันด้วย)
 *************************************************/

function testChkTicketForSub(subId) {

  const auth =
    rocketLogin_();


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


  Logger.log(
    'SUB TICKET: ' +
    ticket.ticketNo +
    ' | STATUS: ' +
    ticket.status +
    ' | PARENT ID: ' +
    ticket.parentTicketId +
    ' | PARENT NO: ' +
    ticket.parentTicketNo
  );


  if (!ticket.parentTicketId) {

    Logger.log(
      'ไม่เจอ parentTicketId จาก sub ticket นี้ ' +
      'เลย — เช็ค id ที่ส่งมาว่าถูกต้องไหม'
    );

    return;

  }


  const request =
    buildChkTicketRequest_(
      ticket.parentTicketId,
      auth
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
    'RAW RESPONSE:\n' +
    res.getContentText('UTF-8')
  );

}



// ปุ่ม "เรียกใช้" ของ Apps Script เรียกฟังก์ชันแบบ
// ไม่มี parameter ได้เท่านั้น เลยทำ wrapper ใส่ id
// ที่ผู้ใช้ส่งมาไว้ตรงนี้แทน
function testChkTicketForKnownSub() {

  testChkTicketForSub(
    '1061322297'
  );

}



/*************************************************
 * INSPECT STAGE BADGE CARDS ON PARENT PAGE
 * (ผู้ใช้ชี้ให้ดู field "ประเภทงานปัจจุบัน" กับ badge
 * การ์ดเล็กๆ ใต้ชื่อ ticket ในหน้า parent — ticket
 * BKRM0826-000560 (parent id 6922804445 จากรอบ
 * testChkTicketForKnownSub ก่อนหน้า) มี 3 การ์ด:
 * เบิกอะไหล่/เสนอราคา (เขียว=เสร็จ) เข้าซ่อม
 * (เหลือง=รอ) — ตรงเป้าหมาย stage ปัจจุบันของผู้ใช้
 * มากกว่า ChkTicket.php และดูมาจากหน้าเดียวกับที่ดึง
 * อยู่แล้ว (ไม่ต้อง request เพิ่ม) — ต้อง inspect
 * โครงสร้าง HTML จริงก่อนเขียน parser
 *************************************************/

function testInspectTicketStageCards() {

  const auth =
    rocketLogin_();


  const parentId =
    '6922804445';


  const url =
    ROCKET.BASE +
    '/main/ticket_view.php?id=' +
    parentId;


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
    'HTTP ' +
    res.getResponseCode() +
    ' | length ' +
    html.length
  );


  const anchor =
    html.indexOf(
      'ประเภทงานปัจจุบัน'
    );


  if (anchor === -1) {

    Logger.log(
      'ไม่เจอ "ประเภทงานปัจจุบัน" ในหน้านี้เลย'
    );

    return;

  }


  // ดึงตั้งแต่ก่อนหน้า field นี้เยอะๆ เพื่อให้ครอบคลุม
  // ส่วน badge การ์ดเล็กๆ ที่อยู่เหนือขึ้นไปด้วย
  const start =
    Math.max(
      0,
      anchor - 4000
    );

  const end =
    Math.min(
      html.length,
      anchor + 1500
    );


  Logger.log(
    'HEADER + STAGE CARDS SECTION:\n' +
    html
      .substring(start, end)
      .replace(/></g, '>\n<')
  );

}



/*************************************************
 * SYNC TICKET STAGE
 *
 * ต่างจาก syncRocket75/syncTrick2 ตรงที่ไม่ต้องไล่
 * parent → sub ticket เลย — ข้อมูล stage ทั้งหมดอยู่
 * ในหน้า parent (ticket_view.php?id=X) หน้าเดียว
 * (ดู testInspectTicketStageCards() ที่ยืนยันโครงสร้าง
 * จริงแล้ว) เลย fetch parent ticket ทีละใบพอ ไม่ต้อง
 * เรียก checkrepair.php หรือ ticket detail เพิ่ม
 *
 * ใช้ Script Properties คนละชุด (prefix SYNC3_) จาก
 * syncRocket75/syncTrick2 เพื่อรันแยกอิสระกันได้
 *
 * Current Stage เป็นการประมาณที่ดีที่สุดเท่านั้น
 * (ดูเหตุผลที่คอมเมนต์ computeCurrentStage_) เก็บ
 * Active Stages (ข้อมูลดิบ) ไว้คู่กันเสมอเพื่อเช็ค
 * ย้อนกลับได้
 *************************************************/

const STAGE_SHEET_NAME =
  'Ticket Stage';



function buildParentPageRequest_(
  parentId,
  auth
) {

  const headers = {};

  if (auth.cookie) {

    headers.Cookie =
      auth.cookie;

  }


  return {

    url:
      ROCKET.BASE +
      '/main/ticket_view.php?id=' +
      parentId,

    method:
      'get',

    headers:
      headers,

    muteHttpExceptions:
      true

  };

}



/*************************************************
 * EXTRACT STAGE CARDS (แก้บั๊ก: regex เดิมจับ
 * "fs-4 fw-bold" + badge ตัวถัดไปแบบหลวมเกินไป ทำให้
 * ดันไปจับการ์ด KPI ทั่วไป เช่น "วันที่เปิดใบงาน"/
 * "เวลารวมล่าสุด (นาที)" ปนเข้ามาด้วย (เห็นจากผลจริง
 * ในชีท Active Stages ที่มีข้อความพวกนี้ปนอยู่)
 *
 * จุดสังเกตที่แยกการ์ด stage สถานะ ออกจากการ์ด KPI
 * ทั่วไปได้ชัดเจน (ดูจาก testInspectTicketStageCards()
 * log จริง): การ์ด stage สถานะ ส่วน
 * <!--begin::Number-->...<!--end::Number--> จะว่าง
 * เปล่าเสมอ (ไม่มีตัวเลข/วันที่ใหญ่ๆ) ต่างจากการ์ด KPI
 * ที่ตัวเลข/วันที่จะอยู่ในส่วนนี้ — เลย scope การค้นหา
 * เป็นทีละ <!--begin::Stat-->...<!--end::Stat--> block
 * ก่อน แล้วกรองด้วยเงื่อนไข Number ว่างเปล่า
 *************************************************/

function extractStageCardsFromHtml_(html) {

  const cards = [];

  const statBlockRegex =
    /<!--begin::Stat-->([\s\S]*?)<!--end::Stat-->/g;

  let blockMatch;


  while (
    (blockMatch = statBlockRegex.exec(html))
    !== null
  ) {

    const block =
      blockMatch[1];


    const numberMatch =
      block.match(
        /<!--begin::Number-->([\s\S]*?)<!--end::Number-->/
      );

    if (
      numberMatch &&
      cleanText_(numberMatch[1]) !== ''
    ) {

      continue;

    }


    const nameMatch =
      block.match(
        /<div class=["']fs-4 fw-bold["']>\s*([\s\S]*?)\s*<\/div>/
      );

    const badgeMatch =
      block.match(
        /<span class=["']badge (badge-[\w-]+)[^"']*["']>\s*([\s\S]*?)<\/span>/
      );

    if (
      !nameMatch ||
      !badgeMatch
    ) {

      continue;

    }


    cards.push({

      name:
        cleanText_(nameMatch[1]),

      badgeClass:
        badgeMatch[1],

      status:
        cleanText_(badgeMatch[2])

    });

  }


  return cards;

}



/*************************************************
 * PARSE PARENT PAGE
 * (regex อิงจาก testInspectTicketStageCards() /
 * testInspectTicketOverview() ที่ inspect โครงสร้าง
 * จริงไว้แล้ว)
 *************************************************/

function extractParentPageStageInfo_(
  html,
  parentId
) {

  const jobNo =
    cleanText_(
      extractRegex_(
        html,
        /<h1[^>]*>([\s\S]*?)<\/h1>/i
      )
    );


  const overallStatus =
    cleanText_(
      extractRegex_(
        html,
        /d-flex align-items-center mb-1[\s\S]*?<span[^>]*class=["'][^"']*badge[^"']*["'][^>]*>([\s\S]*?)<\/span>/i
      )
    );


  const currentJobType =
    cleanText_(
      extractRegex_(
        html,
        /ประเภทงานปัจจุบัน\s*:?\s*<\/b>\s*<span>\s*([\s\S]*?)<\/span>/i
      )
    );


  const cards =
    extractStageCardsFromHtml_(
      html
    );


  return {

    ticketId:
      parentId,

    jobNo:
      jobNo,

    overallStatus:
      overallStatus,

    currentJobType:
      currentJobType,

    cards:
      cards,

    url:
      ROCKET.BASE +
      '/main/ticket_view.php?id=' +
      parentId,

    lastSync:
      new Date()

  };

}



/*************************************************
 * MAP การ์ด → เลข stage (1-10)
 * เช็คคำเฉพาะเจาะจงก่อนคำกว้างเสมอ (เช่น "หลังบ้าน"
 * ก่อน) ป้องกัน "เบิกอะไหล่ หลังบ้าน" ไปแมตช์เป็น
 * "เบิกอะไหล่" ธรรมดา (stage 3) ผิดตัว
 *************************************************/

function classifyStageCard_(name) {

  if (name.indexOf('หลังบ้าน') !== -1) {

    if (name.indexOf('เบิกอะไหล่') !== -1) {

      return 6;

    }

    if (name.indexOf('เสนอราคา') !== -1) {

      return 7;

    }

  }


  if (name.indexOf('ติดตาม') !== -1) {

    return 5;

  }

  if (name.indexOf('เสนอราคา') !== -1) {

    return 4;

  }

  if (name.indexOf('เบิกอะไหล่') !== -1) {

    return 3;

  }

  if (
    name.indexOf('เข้าซ่อม') !== -1 ||
    name.indexOf('ตรวจเช็ค') !== -1
  ) {

    return 2;

  }

  if (name.indexOf('คอลเซ็นเตอร์') !== -1) {

    return 1;

  }

  if (name.indexOf('หัวหน้าธุรการ') !== -1) {

    return 8;

  }

  if (name.indexOf('ธุรการ') !== -1) {

    return 9;

  }

  if (name.indexOf('บัญชี') !== -1) {

    return 10;

  }


  // การ์ดที่ไม่อยู่ใน pipeline 10 stage ที่กำหนด
  // (เช่น "ผู้บริหาร", "บันทึกประจำวัน")
  return null;

}



/*************************************************
 * MAP ข้อความ "ประเภทงานปัจจุบัน" (Current Job Type)
 * → เลข stage (1-10)
 *
 * เจอเคสจริงจากผู้ใช้: ticket ที่ job type ="งานจบ
 * ปิดงาน" (อยู่แท็บ ธุรการเปิดบิล/stage 9 จริง) แต่
 * การ์ด "เข้าซ่อม" (stage 2) ยังค้างเป็นสีเหลือง
 * (รอตรวจงาน) ไม่เคยเปลี่ยนเป็นเขียว แม้ ticket จะ
 * เดินหน้าผ่านไปไกลกว่านั้นมากแล้ว — สรุปว่าการ์ด
 * ไม่ใช่ตัวบอก stage ปัจจุบันที่แม่นยำเสมอไป (การ์ด
 * ค้างเก่าได้) ส่วน "ประเภทงานปัจจุบัน" เป็น field ที่
 * ฝ่ายธุรการน่าจะ maintain ไว้ให้ตรงกับงานที่ทำอยู่
 * จริงมากกว่า เลยใช้เป็นตัวหลักแทน ถ้าข้อความนี้มี
 * หลาย stage ปนกัน (เช่น "เบิกอะไหล่ + เสนอราคา
 * ต่อเนื่อง") ให้เอา stage เลขสูงสุดที่แมตช์ (แปลว่า
 * เป็นงานที่ทำล่าสุด/ไกลสุดในบรรดาที่ระบุ)
 *************************************************/

function classifyJobTypeText_(text) {

  if (!text) {

    return null;

  }


  const hasHome =
    text.indexOf('หลังบ้าน') !== -1;

  const candidates = [];

  function addIfMatch(stage, matched) {

    if (matched) {

      candidates.push(stage);

    }

  }


  addIfMatch(
    10,
    text.indexOf('บัญชี') !== -1
  );

  addIfMatch(
    9,
    text.indexOf('ปิดงาน') !== -1 ||
    text.indexOf('ปิดบิล') !== -1 ||
    text.indexOf('เปิดบิล') !== -1
  );

  addIfMatch(
    8,
    text.indexOf('หัวหน้าธุรการ') !== -1
  );

  addIfMatch(
    9,
    !hasHome &&
    text.indexOf('ธุรการ') !== -1 &&
    text.indexOf('หัวหน้า') === -1
  );

  addIfMatch(
    7,
    hasHome &&
    text.indexOf('เสนอราคา') !== -1
  );

  addIfMatch(
    6,
    hasHome &&
    (
      text.indexOf('เบิกอะไหล่') !== -1 ||
      text.indexOf('อะไหล่') !== -1
    )
  );

  addIfMatch(
    5,
    text.indexOf('ติดตาม') !== -1
  );

  addIfMatch(
    4,
    !hasHome &&
    text.indexOf('เสนอราคา') !== -1
  );

  addIfMatch(
    3,
    !hasHome &&
    (
      text.indexOf('เบิกอะไหล่') !== -1 ||
      text.indexOf('อะไหล่') !== -1 ||
      /part/i.test(text)
    )
  );

  addIfMatch(
    2,
    text.indexOf('ตรวจเช็ค') !== -1 ||
    text.indexOf('เข้าซ่อม') !== -1 ||
    text.indexOf('สำรวจซ่อม') !== -1 ||
    text.indexOf('ซ่อม') !== -1
  );

  addIfMatch(
    1,
    text.indexOf('คอลเซ็นเตอร์') !== -1 ||
    text.indexOf('ออกใบงาน') !== -1 ||
    text.indexOf('ออกเลขที่งาน') !== -1
  );


  if (candidates.length === 0) {

    return null;

  }


  return Math.max.apply(
    null,
    candidates
  );

}



/*************************************************
 * เดา Current Stage แบบ fallback จากการ์ด (ใช้เมื่อ
 * "ประเภทงานปัจจุบัน" ว่าง/แมตช์ไม่ได้เท่านั้น — ดู
 * classifyJobTypeText_ สำหรับตัวหลัก): เอา stage
 * เลขน้อยสุดที่ยังไม่เขียว (ยังไม่ badge-success)
 * เป็นตัวติดขัดอยู่ ถ้าเขียวหมดทุกอันที่เจอ ใช้เลข
 * stage สูงสุดที่เจอแทน (แปลว่าผ่านมาไกลสุดเท่าที่
 * เห็นการ์ด)
 *
 * ข้อจำกัด: การ์ดจะโผล่เฉพาะ stage ที่ "เริ่มแล้ว"
 * เท่านั้น และอาจค้างสถานะเก่าไม่อัปเดตตามจริง (ดู
 * คอมเมนต์ classifyJobTypeText_) ผลลัพธ์นี้เลยเป็น
 * การประมาณสำรองเท่านั้น ไม่ใช่ 100% แม่นยำเป๊ะ
 *************************************************/

function computeCurrentStage_(cards) {

  const matched =
    cards
      .map(function(c) {

        return {

          stageNum:
            classifyStageCard_(c.name),

          isDone:
            /success/i.test(c.badgeClass),

          card: c

        };

      })
      .filter(function(c) {

        return c.stageNum !== null;

      })
      .sort(function(a, b) {

        return a.stageNum - b.stageNum;

      });


  const pending =
    matched.filter(function(c) {

      return !c.isDone;

    });


  if (pending.length > 0) {

    return pending[0].stageNum;

  }


  if (matched.length > 0) {

    return matched[matched.length - 1]
      .stageNum;

  }


  return null;

}



function formatActiveStages_(cards) {

  return cards
    .map(function(c) {

      return (
        c.name +
        ': ' +
        c.status
      );

    })
    .join(', ');

}



const STAGE_HEADERS_ = [

  'Job No.',
  'Overall Status',
  'Current Job Type',
  'Active Stages',
  'Current Stage',
  'Rocket URL',
  'Last Sync'

];



function stageToRow_(d) {

  return [

    d.jobNo,
    d.overallStatus,
    d.currentJobType,

    formatActiveStages_(
      d.cards
    ),

    d.currentStage ||
      '',

    d.url,

    formatDateForSheet_(
      d.lastSync
    )

  ];

}



function buildStageRowIndex_() {

  const ss =
    SpreadsheetApp
      .getActiveSpreadsheet();


  let sheet =
    ss.getSheetByName(
      STAGE_SHEET_NAME
    );


  if (!sheet) {

    sheet =
      ss.insertSheet(
        STAGE_SHEET_NAME
      );

  }


  sheet.getRange(
    1,
    1,
    1,
    STAGE_HEADERS_.length
  ).setValues(
    [STAGE_HEADERS_]
  );


  const index = {};

  const lastRow =
    sheet.getLastRow();


  if (lastRow >= 2) {

    const jobNos =
      sheet.getRange(
        2,
        1,
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



function batchUpsertStage_(
  rows,
  ctx
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

  const lastCol =
    columnLetter_(
      STAGE_HEADERS_.length
    );

  const data = [];

  const newRows = [];


  rows.forEach(function(d) {

    const row =
      stageToRow_(d);

    const existingRow =
      ctx.index[String(d.jobNo)];


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

        jobNo: d.jobNo,
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

      ctx.index[String(r.jobNo)] =
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



function syncTicketStage() {

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
    '========== TICKET STAGE SYNC =========='
  );


  const auth =
    rocketLogin_();

  Logger.log(
    'LOGIN OK'
  );


  const props =
    PropertiesService
      .getScriptProperties();


  let parentIds =
    readJsonProp_(
      props,
      'SYNC3_PARENT_IDS'
    );


  if (parentIds === null) {

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
      'SYNC3_PARENT_IDS',
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


  let pendingParents =
    readJsonProp_(
      props,
      'SYNC3_PENDING_PARENTS'
    );

  if (pendingParents === null) {

    pendingParents =
      parentIds.slice();

  }


  const ctx =
    buildStageRowIndex_();

  // หน้า parent หนักกว่าหน้า sub ticket detail มาก
  // (~350KB ต่อหน้า เทียบกับไม่กี่ KB) เลยใช้ chunk
  // เล็กกว่า syncRocket75/syncTrick2
  const PARENT_CHUNK =
    10;


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

        return buildParentPageRequest_(
          parentId,
          auth
        );

      });

    const responses =
      fetchAllWithRetry_(
        requests,
        3
      );

    const rowsToWrite = [];


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

        const html =
          res.getContentText('UTF-8');

        const info =
          extractParentPageStageInfo_(
            html,
            parentId
          );

        const jobTypeStage =
          classifyJobTypeText_(
            info.currentJobType
          );

        info.currentStage =
          jobTypeStage !== null
            ? jobTypeStage
            : computeCurrentStage_(
                info.cards
              );

        rowsToWrite.push(info);

      } catch (e) {

        Logger.log(
          'ERROR Parent ' +
          parentId +
          ': ' +
          e.message
        );

      }

    });

    batchUpsertStage_(
      rowsToWrite,
      ctx
    );

    pendingParents =
      pendingParents.slice(
        PARENT_CHUNK
      );

    writeJsonProp_(
      props,
      'SYNC3_PENDING_PARENTS',
      pendingParents
    );

    Logger.log(
      'เขียนแล้ว ' +
      (parentIds.length - pendingParents.length) +
      '/' +
      parentIds.length
    );

  }


  if (pendingParents.length > 0) {

    Logger.log(
      'ใกล้ timeout — เหลือ parent อีก ' +
      pendingParents.length +
      ' ตัว กด "เรียกใช้" syncTicketStage ซ้ำเพื่อทำต่อ'
    );

    return;

  }


  props.deleteProperty('SYNC3_PARENT_IDS');
  props.deleteProperty('SYNC3_PENDING_PARENTS');


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
 *************************************************/

function resetSync3State() {

  const props =
    PropertiesService
      .getScriptProperties();


  props.deleteProperty('SYNC3_PARENT_IDS');
  props.deleteProperty('SYNC3_PENDING_PARENTS');


  Logger.log(
    'ล้าง sync state ของ Ticket Stage แล้ว ' +
    'รัน syncTicketStage รอบถัดไปจะเริ่มนับ parent ' +
    'ticket ใหม่ทั้งหมด (ข้อมูลในชีท ' +
    STAGE_SHEET_NAME +
    ' ที่เขียนไปแล้วยังอยู่ครบ ไม่ถูกลบ)'
  );

}



function clearStageSheetData() {

  const ss =
    SpreadsheetApp
      .getActiveSpreadsheet();

  const sheet =
    ss.getSheetByName(
      STAGE_SHEET_NAME
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
    STAGE_SHEET_NAME +
    '" แล้ว (เหลือแค่ header) — ถ้าจะ sync ใหม่ ' +
    'ทั้งหมดให้รัน resetSync3State() ด้วย ก่อนรัน ' +
    'syncTicketStage'
  );

}
