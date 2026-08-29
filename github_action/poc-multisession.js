/*************************************************
 * POC — ทดสอบ multiple login sessions ด้วย account
 * เดียวกัน (ยังไม่ขอ account เพิ่ม)
 *
 * ตอบ 2 คำถาม:
 *   1. login ซ้ำด้วย account เดียวกันแล้ว session เก่า
 *      (A) ยังใช้ได้อยู่ไหม หรือโดน invalidate ทันที
 *   2. ถ้ายังใช้ได้ทั้งคู่ — แบ่งงานไปคนละ session แล้ว
 *      รันคู่ขนานกัน เร็วขึ้นจริงไหม เทียบกับ 1 session
 *      concurrency เท่าเดิม (ทดสอบทฤษฎี PHP session-lock
 *      serialization ที่สงสัยว่าเป็นสาเหตุที่ทำให้
 *      sync-tickets.js ช้าแม้เพิ่ม concurrency)
 *
 * รันแล้วไม่เขียนอะไรลง Google Sheet เลย แค่ fetch มา
 * นับเวลา/ผลลัพธ์ log ออกมาให้ดู
 *************************************************/

const rocket = require('./lib/rocket-client');

// รอบก่อน scan 80 parent ได้ 54 sub ticket (~0.68 ต่อ
// parent) — ตั้ง 60 ต่อชุด (ต้องการ 120 รวม) ให้พอดีกับ
// scan 250 parent ด้านล่างแบบมี margin
const SAMPLE_SIZE = 60;
const TOTAL_CONCURRENCY = 30;

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

async function isSessionValid(auth, testTicketId) {
  try {
    const html = await rocket.getTicketDetailHtml(testTicketId, auth);
    const ticket = rocket.parseTicketDetail(html, testTicketId);
    return Boolean(ticket.ticketNo || ticket.status);
  } catch (e) {
    return false;
  }
}

// retries=0 ตั้งใจ — ทดสอบเวลาให้ยุติธรรม ไม่อยากให้ retry
// (ที่เพิ่งเพิ่มใน mapConcurrent) มาบิดผลเวลาที่วัดได้
async function fetchBatch(subIds, auth, concurrency) {
  const results = await rocket.mapConcurrent(subIds, concurrency, async function(subId) {
    const html = await rocket.getTicketDetailHtml(subId, auth);
    const ticket = rocket.parseTicketDetail(html, subId);
    if (!ticket.ticketNo && !ticket.status) {
      throw new Error('parse ไม่สำเร็จ');
    }
    return ticket;
  }, 0);

  const successCount = results.filter(function(r) { return r && !r.__error; }).length;
  return { successCount: successCount, errorCount: results.length - successCount };
}

async function main() {

  console.log('========== POC: MULTIPLE LOGIN SESSIONS (account เดียวกัน) ==========');

  console.log('Login session A...');
  const authA = await rocket.rocketLogin();
  console.log('Session A OK');

  await sleep(1000);

  console.log('Login session B (account เดียวกัน)...');
  const authB = await rocket.rocketLogin();
  console.log('Session B OK');

  // ==========================================
  // ดึง sub ticket ID จริงมาทำ sample เทียบเวลา
  // ==========================================

  const range = rocket.computeLast3MonthsRangeBangkok();
  const parentHtml = await rocket.getParentTicketHtml(authA, range.start, range.end);
  const parentIds = rocket.extractParentTicketIds(parentHtml);
  console.log('PARENT TICKETS ทั้งหมด: ' + parentIds.length);

  const checkRepairResults = await rocket.mapConcurrent(
    parentIds.slice(0, 250), 30,
    async function(parentId) {
      const html = await rocket.getCheckRepairHtml(parentId, authA);
      return rocket.extractCheckRepairIds(html);
    }
  );

  let allSubIds = [];
  checkRepairResults.forEach(function(r) {
    if (Array.isArray(r)) {
      allSubIds = allSubIds.concat(r);
    }
  });
  allSubIds = [...new Set(allSubIds)];
  console.log('SUB TICKETS ที่เจอทั้งหมด (จาก parent ที่ scan): ' + allSubIds.length);

  // สำคัญ: BASELINE กับ MULTI-SESSION ต้องใช้ตั๋วคนละชุด
  // ไม่ทับกันเลย — ถ้าใช้ชุดเดียวกันซ้ำ รอบสองจะเร็วขึ้น
  // เพราะ cache ฝั่งเซิร์ฟเวอร์/DB (เพิ่งเจอปัญหานี้จริงจาก
  // การรันครั้งแรก ได้ 14.2x ซึ่งเกินกว่าที่ session-lock
  // เพียงอย่างเดียวจะอธิบายได้ — คือ cache effect ปนอยู่)
  const neededTotal = SAMPLE_SIZE * 2;
  if (allSubIds.length < neededTotal) {
    throw new Error(
      'sub ticket ไม่พอสำหรับแบ่ง 2 ชุดไม่ทับกัน (ได้ ' + allSubIds.length +
      ' ต้องการอย่างน้อย ' + neededTotal + ') ลองเพิ่มจำนวน parent ที่ scan ในโค้ด'
    );
  }

  const baselineSample = allSubIds.slice(0, SAMPLE_SIZE);
  const multiSample = allSubIds.slice(SAMPLE_SIZE, SAMPLE_SIZE * 2);
  console.log('BASELINE sample: ' + baselineSample.length + ' ใบ / MULTI-SESSION sample: ' + multiSample.length + ' ใบ (คนละชุด ไม่ทับกัน)');

  // ==========================================
  // เช็คว่า session A ยังใช้ได้ไหมหลัง login session B
  // ==========================================

  console.log('--- เช็ค session A หลัง login session B ---');
  const stillValid = await isSessionValid(authA, allSubIds[0]);

  if (!stillValid) {
    console.log('ผล: session A ใช้ไม่ได้แล้ว! (โดน invalidate ตอน login session B ด้วย account เดียวกัน)');
    console.log('สรุป: rocket75.com อนุญาต 1 session ต่อ 1 account เท่านั้น — ต้องขอ account จริงเพิ่มถึงจะทำ multi-session ได้');
    return;
  }
  console.log('ผล: session A ยังใช้ได้ปกติ ไม่โดน invalidate — ไปต่อขั้นวัดความเร็ว');

  // ==========================================
  // BASELINE: 1 session, concurrency 30
  // ==========================================

  console.log('--- BASELINE: 1 session, concurrency ' + TOTAL_CONCURRENCY + ' ---');
  const t1Start = Date.now();
  const baseline = await fetchBatch(baselineSample, authA, TOTAL_CONCURRENCY);
  const t1 = Date.now() - t1Start;
  console.log(
    'BASELINE: ' + (t1 / 1000).toFixed(1) + 's — สำเร็จ ' +
    baseline.successCount + '/' + baselineSample.length
  );

  await sleep(3000);

  // ==========================================
  // MULTI-SESSION: 2 sessions คู่ขนาน, concurrency 15 ต่อ session
  // (คนละตั๋วกับ BASELINE ทั้งหมด — กัน cache effect)
  // ==========================================

  const perSessionConcurrency = TOTAL_CONCURRENCY / 2;
  console.log('--- MULTI-SESSION: 2 sessions x concurrency ' + perSessionConcurrency + ' พร้อมกัน ---');

  const half = Math.ceil(multiSample.length / 2);
  const groupA = multiSample.slice(0, half);
  const groupB = multiSample.slice(half);

  const t2Start = Date.now();
  const [resA, resB] = await Promise.all([
    fetchBatch(groupA, authA, perSessionConcurrency),
    fetchBatch(groupB, authB, perSessionConcurrency)
  ]);
  const t2 = Date.now() - t2Start;
  const multiSuccess = resA.successCount + resB.successCount;
  console.log(
    'MULTI-SESSION: ' + (t2 / 1000).toFixed(1) + 's — สำเร็จ ' +
    multiSuccess + '/' + multiSample.length
  );

  // ==========================================
  // สรุปผล
  // ==========================================

  const speedup = t1 / t2;
  console.log('=======================================');
  console.log('BASELINE      : ' + (t1 / 1000).toFixed(1) + 's');
  console.log('MULTI-SESSION : ' + (t2 / 1000).toFixed(1) + 's');
  console.log('เร็วขึ้น        : ' + speedup.toFixed(2) + 'x');
  console.log(
    speedup > 1.5
      ? '=> ทฤษฎี session-lock น่าจะถูก คุ้มค่าที่จะทำ multi-session จริงจัง (แต่ต้องขอ account เพิ่มเพราะ account เดียวมี session เดียว)'
      : '=> ไม่ช่วยเท่าที่คาด bottleneck อาจไม่ใช่ session-lock ล้วนๆ (อาจเป็น per-request render time หรือ rate-limit ระดับอื่น)'
  );

}

main().catch(function(err) {
  console.error('ทดสอบล้มเหลว:', err);
  process.exit(1);
});
