/*************************************************
 * POC — ตรวจสอบ ticket ที่หายไปจากชีท Tickets
 *
 * เคสที่เจอ: parent BKPM0826-000303 (id=1627167229),
 * sub ticket BKPM0826-000303.C01 (id=4311686020) มีจริง
 * บน rocket75.com เดือนนี้เอง แต่ไม่อยู่ในชีท Tickets เลย
 *
 * เช็คทีละขั้นตอนของ pipeline เดียวกับ sync-tickets.js
 * ว่าตกหล่นตรงไหน:
 *   1. parent id นี้อยู่ใน getTable.php (parent list) ไหม
 *   2. ถ้าอยู่ — sub id นี้อยู่ใน checkrepair.php ของ
 *      parent นั้นไหม
 *   3. ถ้าอยู่ — fetch+parse รายละเอียด sub ticket ได้ปกติไหม
 *
 * ตั้งค่า parent_id/sub_id ผ่าน workflow_dispatch input ได้
 * (default เป็นเคสที่เจอ) ไม่เขียนอะไรลง Google Sheet เลย
 *************************************************/

const rocket = require('./lib/rocket-client');

const PARENT_ID = process.env.CHECK_PARENT_ID || '1627167229';
const SUB_ID = process.env.CHECK_SUB_ID || '4311686020';

async function main() {

  console.log('========== POC: ตรวจสอบ ticket ที่หายไป ==========');
  console.log('parent_id = ' + PARENT_ID + ' / sub_id = ' + SUB_ID);

  const auth = await rocket.rocketLogin();
  console.log('LOGIN OK');

  const range = rocket.computeLast3MonthsRangeBangkok();
  console.log('ช่วงวันที่ (เหมือน sync-tickets.js): ' + range.start + ' - ' + range.end);

  // ==========================================
  // 1. parent id นี้อยู่ใน parent list ไหม
  // ==========================================

  const parentHtml = await rocket.getParentTicketHtml(auth, range.start, range.end);
  const parentIds = rocket.extractParentTicketIds(parentHtml);
  console.log('PARENT TICKETS ทั้งหมดที่ scan ได้: ' + parentIds.length);

  const parentFound = parentIds.indexOf(String(PARENT_ID)) !== -1;
  console.log('--- ขั้นที่ 1: parent ' + PARENT_ID + ' อยู่ใน parent list ไหม ---');
  console.log(parentFound ? 'พบ — ผ่านขั้นที่ 1' : 'ไม่พบ! parent ticket นี้ไม่อยู่ในผลลัพธ์ getTable.php เลย');

  if (!parentFound) {
    console.log('สรุป: ตกหล่นตั้งแต่ parent list — getTable.php ไม่คืน parent นี้มาด้วยเงื่อนไข/พารามิเตอร์ปัจจุบัน');
    return;
  }

  // ==========================================
  // 2. sub id นี้อยู่ใน checkrepair.php ของ parent นี้ไหม
  // ==========================================

  const checkRepairHtml = await rocket.getCheckRepairHtml(PARENT_ID, auth);
  const subIds = rocket.extractCheckRepairIds(checkRepairHtml);
  console.log('SUB TICKETS ของ parent นี้: ' + JSON.stringify(subIds));

  const subFound = subIds.indexOf(String(SUB_ID)) !== -1;
  console.log('--- ขั้นที่ 2: sub ' + SUB_ID + ' อยู่ใน checkrepair.php ของ parent นี้ไหม ---');
  console.log(subFound ? 'พบ — ผ่านขั้นที่ 2' : 'ไม่พบ! sub ticket นี้ไม่อยู่ใน checkrepair.php ของ parent เลย');

  if (!subFound) {
    console.log('สรุป: parent อยู่ใน list แต่ sub ticket นี้ไม่ถูกดึงออกมาจาก checkrepair.php ของ parent — น่าจะเป็นปัญหาการ parse/regex หรือสถานะพิเศษที่หน้า checkrepair ไม่แสดง');
    console.log('checkrepair.php ดิบ (500 ตัวอักษรแรก): ' + checkRepairHtml.substring(0, 500));
    return;
  }

  // เช็คว่าเลขตั๋วเต็มๆ (เช่น BKPM0826-000303.C01) โผล่เป็น
  // ข้อความอยู่ตรงนี้แล้วหรือเปล่า ก่อนที่จะต้องไปหน้า detail
  // แล้วเดา suffix จาก <h1> เอง — ถ้ามีอยู่แล้วตรงนี้จะดึงตรง
  // มาได้เลย ทนทานกว่าเดา pattern เยอะ
  const linkIndex = checkRepairHtml.indexOf('id=' + SUB_ID);
  if (linkIndex !== -1) {
    const contextStart = Math.max(0, linkIndex - 400);
    const contextEnd = Math.min(checkRepairHtml.length, linkIndex + 400);
    console.log('--- HTML รอบๆ ลิงก์ sub ticket นี้ใน checkrepair.php (±400 ตัวอักษร) ---');
    console.log(checkRepairHtml.substring(contextStart, contextEnd));
  }

  // ==========================================
  // 3. fetch + parse รายละเอียด sub ticket
  // ==========================================

  console.log('--- ขั้นที่ 3: fetch + parse รายละเอียด sub ticket ---');
  const detailHtml = await rocket.getTicketDetailHtml(SUB_ID, auth);
  const ticket = rocket.parseTicketDetail(detailHtml, SUB_ID);
  console.log('ผลลัพธ์ parse: ' + JSON.stringify(ticket, null, 2));

  if (!ticket.ticketNo && !ticket.status) {
    console.log('สรุป: fetch หน้ารายละเอียดได้ แต่ parse ไม่ออกเลย (ticketNo และ status ว่างทั้งคู่) — หน้าเว็บอาจเปลี่ยนโครงสร้าง หรือ session มีปัญหาตอน fetch');
  } else {
    console.log('สรุป: ผ่านทั้ง 3 ขั้นตอน — ticket นี้ควรจะถูก sync ได้ปกติ ถ้ายังหายไปจากชีทจริง ปัญหาน่าจะอยู่ที่ฝั่งเขียน Sheet (batchUpsert) แทน ไม่ใช่ฝั่ง fetch');
  }

}

main().catch(function(err) {
  console.error('ทดสอบล้มเหลว:', err);
  process.exit(1);
});
