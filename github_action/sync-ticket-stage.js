/*************************************************
 * SYNC TICKET STAGE — Node.js port ของ
 * syncTicketStage() (stage.js)
 *
 * ทดสอบผ่านแล้วบนชีท "Ticket Stage (Test)" — Apps
 * Script trigger เดิมปิดไปแล้ว จึงสลับมาเขียนชีท
 * "Ticket Stage" จริง
 *
 * ข้อจำกัดเดียวกับฝั่ง Apps Script: ยังไม่มีทั้ง prune
 * และ skip-if-closed (parent ticket ไม่มีฟิลด์ปิดงาน
 * ชัดเจนเท่า Repair Result และชีทนี้ key ด้วย Job No.
 * ไม่ใช่ parent id ตรงๆ) — ยัง fetch ทุก parent ticket
 * ทุกรอบเหมือนเดิม
 *
 * รองรับ env var สำหรับรัน test แบบจำกัดจำนวนเข้าชีทแยก
 * ต่างหาก โดยไม่ต้องแยกไฟล์โค้ดซ้ำ (ดู .github/workflows/
 * ticket-stage-test.yml):
 *   STAGE_SHEET_NAME_OVERRIDE — ชื่อชีทปลายทาง (default: 'Ticket Stage')
 *   PARENT_LIMIT              — จำกัดจำนวน parent ticket ที่ทดสอบ
 *   RANGE_START_OVERRIDE      — วันที่เริ่ม scan (dd/MM/yyyy, ต้องคู่กับด้านล่าง)
 *   RANGE_END_OVERRIDE        — วันที่สิ้นสุด scan (dd/MM/yyyy)
 *************************************************/

const rocket = require('./lib/rocket-client');
const sheetsLib = require('./lib/sheets-client');

// override ได้ผ่าน env var สำหรับรัน test แบบจำกัดจำนวน
// เข้าชีทแยกต่างหาก โดยไม่ต้องแยกไฟล์โค้ดซ้ำ (กันโค้ด
// production กับ test เพี้ยนออกจากกันทีหลัง)
const STAGE_SHEET_NAME = process.env.STAGE_SHEET_NAME_OVERRIDE || 'Ticket Stage';
const PARENT_LIMIT = process.env.PARENT_LIMIT ? Number(process.env.PARENT_LIMIT) : null;

const PARENT_CONCURRENCY = 30;

const STAGE_HEADERS = [
  'Job No.', 'Overall Status', 'Current Job Type', 'Active Stages', 'Current Stage', 'Rocket URL', 'Last Sync'
];



/*************************************************
 * แกะการ์ด stage จากหน้า parent (port ตรงจาก
 * extractStageCardsFromHtml_ ใน stage.js — scope ไปที่
 * <!--begin::Stat-->...<!--end::Stat--> block แล้วกรอง
 * ด้วย <!--begin::Number-->...<!--end::Number--> ต้อง
 * ว่างเปล่า กัน false positive กับการ์ด KPI ทั่วไป)
 *************************************************/

function extractStageCardsFromHtml(html) {

  const cards = [];
  const statBlockRegex = /<!--begin::Stat-->([\s\S]*?)<!--end::Stat-->/g;
  let blockMatch;

  while ((blockMatch = statBlockRegex.exec(html)) !== null) {

    const block = blockMatch[1];

    const numberMatch = block.match(/<!--begin::Number-->([\s\S]*?)<!--end::Number-->/);
    if (numberMatch && rocket.cleanText(numberMatch[1]) !== '') {
      continue;
    }

    const nameMatch = block.match(/<div class=["']fs-4 fw-bold["']>\s*([\s\S]*?)\s*<\/div>/);
    const badgeMatch = block.match(/<span class=["']badge (badge-[\w-]+)[^"']*["']>\s*([\s\S]*?)<\/span>/);

    if (!nameMatch || !badgeMatch) {
      continue;
    }

    cards.push({
      name: rocket.cleanText(nameMatch[1]),
      badgeClass: badgeMatch[1],
      status: rocket.cleanText(badgeMatch[2])
    });

  }

  return cards;

}



function extractParentPageStageInfo(html, parentId) {

  const jobNo = rocket.cleanText(rocket.extractRegex(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i));

  const overallStatus = rocket.cleanText(rocket.extractRegex(
    html,
    /d-flex align-items-center mb-1[\s\S]*?<span[^>]*class=["'][^"']*badge[^"']*["'][^>]*>([\s\S]*?)<\/span>/i
  ));

  const currentJobType = rocket.cleanText(rocket.extractRegex(
    html,
    /ประเภทงานปัจจุบัน\s*:?\s*<\/b>\s*<span>\s*([\s\S]*?)<\/span>/i
  ));

  const cards = extractStageCardsFromHtml(html);

  return {
    ticketId: parentId,
    jobNo: jobNo,
    overallStatus: overallStatus,
    currentJobType: currentJobType,
    cards: cards,
    url: rocket.ROCKET_BASE + '/main/ticket_view.php?id=' + parentId
  };

}



/*************************************************
 * MAP การ์ด → เลข stage (port ตรงจาก classifyStageCard_)
 *************************************************/

function classifyStageCard(name) {

  if (name.indexOf('หลังบ้าน') !== -1) {
    if (name.indexOf('เบิกอะไหล่') !== -1) return 6;
    if (name.indexOf('เสนอราคา') !== -1) return 7;
  }

  if (name.indexOf('ติดตาม') !== -1) return 5;
  if (name.indexOf('เสนอราคา') !== -1) return 4;
  if (name.indexOf('เบิกอะไหล่') !== -1) return 3;
  if (name.indexOf('เข้าซ่อม') !== -1 || name.indexOf('ตรวจเช็ค') !== -1) return 2;
  if (name.indexOf('คอลเซ็นเตอร์') !== -1) return 1;
  if (name.indexOf('หัวหน้าธุรการ') !== -1) return 8;
  if (name.indexOf('ธุรการ') !== -1) return 9;
  if (name.indexOf('บัญชี') !== -1) return 10;

  return null;

}



/*************************************************
 * MAP ข้อความ "ประเภทงานปัจจุบัน" → เลข stage
 * (port ตรงจาก classifyJobTypeText_ — แหล่งข้อมูลหลัก
 * แม่นกว่าการ์ด เพราะการ์ดค้างสถานะเก่าได้ ดู
 * ROCKET75-SYNC-NOTES.md สำหรับเคสจริงที่เจอ)
 *************************************************/

function classifyJobTypeText(text) {

  if (!text) {
    return null;
  }

  const hasHome = text.indexOf('หลังบ้าน') !== -1;
  const candidates = [];

  function addIfMatch(stage, matched) {
    if (matched) {
      candidates.push(stage);
    }
  }

  addIfMatch(10, text.indexOf('บัญชี') !== -1);
  addIfMatch(9, text.indexOf('ปิดงาน') !== -1 || text.indexOf('ปิดบิล') !== -1 || text.indexOf('เปิดบิล') !== -1);
  addIfMatch(8, text.indexOf('หัวหน้าธุรการ') !== -1);
  addIfMatch(9, !hasHome && text.indexOf('ธุรการ') !== -1 && text.indexOf('หัวหน้า') === -1);
  addIfMatch(7, hasHome && text.indexOf('เสนอราคา') !== -1);
  addIfMatch(6, hasHome && (text.indexOf('เบิกอะไหล่') !== -1 || text.indexOf('อะไหล่') !== -1));
  addIfMatch(5, text.indexOf('ติดตาม') !== -1);
  addIfMatch(4, !hasHome && text.indexOf('เสนอราคา') !== -1);
  addIfMatch(3, !hasHome && (text.indexOf('เบิกอะไหล่') !== -1 || text.indexOf('อะไหล่') !== -1 || /part/i.test(text)));
  addIfMatch(2, text.indexOf('ตรวจเช็ค') !== -1 || text.indexOf('เข้าซ่อม') !== -1 || text.indexOf('สำรวจซ่อม') !== -1 || text.indexOf('ซ่อม') !== -1);
  addIfMatch(1, text.indexOf('คอลเซ็นเตอร์') !== -1 || text.indexOf('ออกใบงาน') !== -1 || text.indexOf('ออกเลขที่งาน') !== -1);

  if (candidates.length === 0) {
    return null;
  }

  return Math.max.apply(null, candidates);

}



// fallback เมื่อ classifyJobTypeText คืน null เท่านั้น
// (port ตรงจาก computeCurrentStage_)
function computeCurrentStage(cards) {

  const matched = cards
    .map(function(c) {
      return {
        stageNum: classifyStageCard(c.name),
        isDone: /success/i.test(c.badgeClass),
        card: c
      };
    })
    .filter(function(c) { return c.stageNum !== null; })
    .sort(function(a, b) { return a.stageNum - b.stageNum; });

  const pending = matched.filter(function(c) { return !c.isDone; });

  if (pending.length > 0) {
    return pending[0].stageNum;
  }
  if (matched.length > 0) {
    return matched[matched.length - 1].stageNum;
  }
  return null;

}



function formatActiveStages(cards) {
  return cards.map(function(c) { return c.name + ': ' + c.status; }).join(', ');
}



// หา stage สูงสุดที่การ์ดไหนก็ตามแมตช์ได้ (ไม่สนใจว่า
// done/pending) — ใช้เสริม jobTypeStage เท่านั้น ไม่ได้แทนที่
// computeCurrentStage (ยังใช้ตอน text ว่างเหมือนเดิม)
function highestCardStage(cards) {

  const stages = cards
    .map(function(c) { return classifyStageCard(c.name); })
    .filter(function(s) { return s !== null; });

  return stages.length > 0 ? Math.max.apply(null, stages) : null;

}



function stageToRow(d, lastSync) {
  return [
    d.jobNo, d.overallStatus, d.currentJobType,
    formatActiveStages(d.cards), d.currentStage || '',
    d.url, lastSync
  ];
}



async function main() {

  console.log('========== TICKET STAGE SYNC (Node.js / GitHub Actions) ==========');

  const auth = await rocket.rocketLogin();
  console.log('LOGIN OK');

  // override ได้ผ่าน env var (รูปแบบ dd/MM/yyyy) เผื่อทดสอบ
  // ด้วยช่วงวันที่แคบกว่า 3 เดือนปกติ — ตัว getTable.php เอง
  // เป็น request ที่หนักที่สุด (ต้อง scan ทั้ง 3 เดือนก่อนเสมอ
  // ต่อให้ PARENT_LIMIT จะตัดเหลือกี่ใบทีหลังก็ตาม) กำหนด
  // ช่วงแคบตรงนี้เลยจะเร็วกว่ารอ scan เต็มแล้วค่อยตัด
  const range = (process.env.RANGE_START_OVERRIDE && process.env.RANGE_END_OVERRIDE)
    ? { start: process.env.RANGE_START_OVERRIDE, end: process.env.RANGE_END_OVERRIDE }
    : rocket.computeLast3MonthsRangeBangkok();
  console.log('ช่วงวันที่: ' + range.start + ' - ' + range.end);

  const parentHtml = await rocket.getParentTicketHtml(auth, range.start, range.end);
  const parentIds = rocket.extractParentTicketIds(parentHtml);
  console.log('PARENT TICKETS: ' + parentIds.length);

  // getTable.php อาจตอบ 200 กลับมาแบบไม่ใช่ตารางจริง (session
  // สะดุด) ทำให้ extractParentTicketIds คืน [] เงียบๆ — abort
  // ก่อนดีกว่าเขียนสถานะผิดพลาดทับของเดิม
  if (parentIds.length === 0) {
    throw new Error('พบ 0 parent ticket — น่าจะเป็น fetch/parse ผิดพลาดชั่วคราว ไม่ใช่ข้อมูลจริง');
  }

  const targetParentIds = PARENT_LIMIT ? parentIds.slice(0, PARENT_LIMIT) : parentIds;
  if (PARENT_LIMIT) {
    console.log('PARENT_LIMIT=' + PARENT_LIMIT + ' — ทดสอบแค่ ' + targetParentIds.length + ' ใบแรก');
  }

  const results = await rocket.mapConcurrentStrict(targetParentIds, PARENT_CONCURRENCY, async function(parentId) {
    const html = await rocket.getParentPageHtml(parentId, auth);
    const info = extractParentPageStageInfo(html, parentId);
    // เหมือนบั๊กที่เจอใน sync-tickets.js/sync-trick2.js —
    // ต่างกันตรงที่ jobNo ที่นี่ parse มาจาก html เอง (ไม่ใช่
    // parameter ที่ผ่านมาตรงๆ) หน้า session สะดุดจะทำให้ jobNo
    // ว่าง แล้วถูกใช้เป็น upsert key ตรงๆ กลายเป็นแถวว่างซ้ำๆ
    // ต้อง throw ตั้งแต่ตรงนี้แทน
    if (!info.jobNo) {
      throw new Error('หน้าที่ได้ไม่ใช่ ticket page จริง (parse jobNo ไม่สำเร็จ)');
    }
    const jobTypeStage = classifyJobTypeText(info.currentJobType);

    if (jobTypeStage === null) {
      // เหมือนเดิมทุกประการ — ตอน text ว่าง/แมตช์ไม่ได้เลย
      // ใช้การ์ดแบบ pending-first (computeCurrentStage) ตามที่
      // เคยแก้ปัญหาการ์ดค้างสถานะเก่าไว้แล้ว
      info.currentStage = computeCurrentStage(info.cards);
    } else {
      // text ให้ค่ามาแล้ว แต่คำที่ฝ่ายธุรการพิมพ์ไม่ครอบคลุมทุก
      // stage (เช่น "เปิดบิลลูกค้าภายนอก" ไม่มีคำว่า "บัญชี"
      // เลยทั้งที่ตั๋วอยู่แท็บบัญชีจริงบนเว็บ) — ถ้ามีการ์ดไหน
      // แมตช์ stage สูงกว่า text ให้เชื่อการ์ดแทน เพราะการ์ด
      // โผล่มาแปลว่าตั๋วไปถึงจุดนั้นจริง (ต่างจากปัญหาเดิมที่
      // การ์ดค้าง "ต่ำ" กว่าความจริง — กรณีนี้การ์ดสูงกว่าความจริง
      // ไม่มีทางเกิดขึ้น เพราะการ์ดจะไม่โผล่ถ้ายังไปไม่ถึง)
      const cardStage = highestCardStage(info.cards);
      info.currentStage = (cardStage !== null && cardStage > jobTypeStage) ? cardStage : jobTypeStage;
    }

    return info;
  });

  const lastSync = rocket.formatDateTimeBangkok(new Date());

  const rows = [];
  results.forEach(function(r, i) {
    if (r && r.__error) {
      console.log('ERROR Parent ' + targetParentIds[i] + ': ' + r.__error);
    } else if (r) {
      rows.push(stageToRow(r, lastSync));
    }
  });

  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new Error('ไม่พบ SPREADSHEET_ID ใน environment variables');
  }
  const sheets = await sheetsLib.getSheetsClient();

  const sheetId = await sheetsLib.ensureSheetExists(sheets, spreadsheetId, STAGE_SHEET_NAME);

  const summaryText = 'ช่วงข้อมูล ' + range.start + ' - ' + range.end + ' | จำนวน ' + rows.length.toLocaleString('en-US') + ' รายการ';
  await sheetsLib.replaceSheetDataWithSummary(sheets, spreadsheetId, sheetId, STAGE_SHEET_NAME, summaryText, STAGE_HEADERS, rows);

  console.log('เขียนลงชีท \'' + STAGE_SHEET_NAME + '\' สำเร็จ: ' + rows.length + ' แถว (' + summaryText + ')');
  console.log('DONE');

}

main().catch(function(err) {
  console.error('Sync ล้มเหลว:', err);
  process.exit(1);
});
