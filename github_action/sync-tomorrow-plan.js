/*************************************************
 * SYNC TOMORROW TECHNICIAN PLAN
 *
 * รายงานตั๋วที่มี "วันที่นัดหมาย" (appointment) ตรงกับ
 * วันพรุ่งนี้เสมอ (ตามเวลากรุงเทพ) — ใช้ endpoint เดียวกับ
 * Tickets sync (getTable.php) แต่ส่ง date_type=2 แทน
 * date_type=1 (ยืนยันจริงจาก DevTools: dropdown "ค้นหาจาก
 * วัน" บนหน้า ticket_list.php เลือก "วันที่นัดหมาย" ตรงกับ
 * date_type=2 พอดี — คนละ field วันที่กับที่ Tickets/Trick2/
 * Ticket Stage ใช้อยู่ (date_type=1 น่าจะเป็นวันที่แจ้ง/
 * สร้างตั๋ว) เห็นชัดว่าเป็นสาเหตุที่ Tickets sync พลาดตั๋ว
 * เก่าที่ยังมีนัดหมายต่อเนื่อง (ดู BKRM0326-000649.R03 ที่
 * คุยกันไปก่อนหน้านี้)
 *
 * ไม่ต้องมี skip-if-closed (ลิสต์นี้เล็ก เปลี่ยนทุกวันอยู่
 * แล้ว ไม่คุ้มจะ optimize) แต่ยังคง prune ไว้ — ถ้าวันไหน
 * ไม่มีนัดหมายเลยจริงๆ ชีทควรว่างเปล่าตามจริง (ต่างจาก
 * Tickets ที่ 0 รายการถือว่าผิดปกติ เพราะลิสต์นี้เป็นแค่
 * snapshot ของพรุ่งนี้ ไม่ใช่ข้อมูลสะสม 3 เดือน)
 *************************************************/

const rocket = require('./lib/rocket-client');
const sheetsLib = require('./lib/sheets-client');

const PLAN_SHEET_NAME = 'Tomorrow Technician Plan';
const DATE_TYPE_APPOINTMENT = '2';

const PARENT_CONCURRENCY = 30;
const SUB_CONCURRENCY = 30;

const PLAN_HEADERS = [
  'Ticket No', 'Appointment', 'Customer', 'Branch', 'Contact', 'Phone',
  'Problem Reported', 'Product Name', 'Technician', 'Team', 'Serial', 'URL', 'Last Sync'
];

const TICKET_ID_COL = PLAN_HEADERS.length + 1; // เก็บ Ticket ID ไว้คอลัมน์ท้ายสุด ใช้เป็น key เท่านั้น ไม่โชว์ตรงๆ ให้ผู้ใช้



function planToRow(d, lastSync) {
  return [
    d.ticketNo, d.appointment, d.customer, d.branch, d.contact, d.phone,
    d.problem, d.productName, d.technician, d.team || '', d.serial || '', d.url, lastSync,
    d.ticketId
  ];
}



async function main() {

  console.log('========== TOMORROW TECHNICIAN PLAN SYNC (Node.js / GitHub Actions) ==========');

  const auth = await rocket.rocketLogin();
  console.log('LOGIN OK');

  // สำหรับทดสอบ: เปลี่ยนเป็นวันนี้ (computeTodayRangeBangkok)
  const range = rocket.computeTodayRangeBangkok();
  console.log('วันที่นัดหมาย (วันนี้ สำหรับ TEST): ' + range.start);

  // ==========================================
  // 1. PARENT TICKETS ที่มีนัดหมายวันนี้ (date_type=2)
  // ==========================================

  const parentHtml = await rocket.getParentTicketHtml(auth, range.start, range.end, DATE_TYPE_APPOINTMENT);
  const parentIds = rocket.extractParentTicketIds(parentHtml);
  console.log('PARENT TICKETS ที่พบจากการค้นหา: ' + parentIds.length);

  // ==========================================
  // 2. CANDIDATE SUB TICKETS + ช่าง/ทีม ต่อ parent
  // (checkrepair.php จะคืนทุก revision .R01, .R02... ของ parent และมีชื่อช่างที่รับผิดชอบ)
  // ==========================================

  let candidateSubIds = [];
  let infoMap = {};

  if (parentIds.length > 0) {
    const checkRepairResults = await rocket.mapConcurrent(parentIds, PARENT_CONCURRENCY, async function(parentId) {
      const html = await rocket.getCheckRepairHtml(parentId, auth);
      return {
        ids: rocket.extractCheckRepairIds(html),
        info: rocket.extractCheckRepairInfo(html)
      };
    });

    checkRepairResults.forEach(function(r, i) {
      if (r && r.__error) {
        console.log('ERROR Parent ' + parentIds[i] + ': ' + r.__error);
      } else if (r) {
        candidateSubIds = candidateSubIds.concat(r.ids);
        Object.assign(infoMap, r.info);
      }
    });
    candidateSubIds = [...new Set(candidateSubIds)];
  }

  console.log('CANDIDATE SUB TICKETS ทั้งหมด: ' + candidateSubIds.length);

  // ==========================================
  // 3. FETCH DETAIL + FILTER เฉพาะตั๋วที่นัดหมายตรงกับวันพรุ่งนี้จริงๆ
  // ==========================================

  let tomorrowTickets = [];

  if (candidateSubIds.length > 0) {
    const detailResults = await rocket.mapConcurrent(candidateSubIds, SUB_CONCURRENCY, async function(subId) {
      const html = await rocket.getTicketDetailHtml(subId, auth);
      const ticket = rocket.parseTicketDetail(html, subId);
      if (!ticket.ticketNo && !ticket.status) {
        throw new Error('หน้าที่ได้ไม่ใช่ ticket detail จริง (parse ไม่สำเร็จ)');
      }
      const info = infoMap[String(subId)] || {};
      ticket.technician = info.technicians || ticket.technician || '';
      ticket.team = info.team || '';
      return ticket;
    });

    detailResults.forEach(function(r, i) {
      if (r && r.__error) {
        console.log('ERROR SubTicket ' + candidateSubIds[i] + ': ' + r.__error);
      } else if (r) {
        if (rocket.isMatchingDateParts(r.appointment, range.dateParts)) {
          tomorrowTickets.push(r);
        } else {
          console.log('ข้ามตั๋ว ' + (r.ticketNo || r.ticketId) + ' (นัดหมาย: "' + (r.appointment || 'ไม่มี') + '" ไม่ใช่วันพรุ่งนี้)');
        }
      }
    });
  }

  console.log('SUB TICKETS ที่มีนัดหมายตรงกับวันพรุ่งนี้จริง: ' + tomorrowTickets.length);

  // ==========================================
  // 4. SORT BY APPOINTMENT (จัดเรียงจากเช้า ไปเย็น)
  // ==========================================

  tomorrowTickets.sort(function(a, b) {
    const timeA = rocket.parseAppointmentTimestamp(a.appointment);
    const timeB = rocket.parseAppointmentTimestamp(b.appointment);
    if (timeA !== timeB) {
      return timeA - timeB;
    }
    return (a.ticketNo || '').localeCompare(b.ticketNo || '');
  });

  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new Error('ไม่พบ SPREADSHEET_ID ใน environment variables');
  }
  const sheets = await sheetsLib.getSheetsClient();

  // ต่างจาก SpreadsheetApp — Sheets API ไม่สร้างแท็บ
  // ใหม่ให้อัตโนมัติ ต้องเช็ค+สร้างเองก่อนเสมอ
  const sheetId = await sheetsLib.ensureSheetExists(sheets, spreadsheetId, PLAN_SHEET_NAME);

  // ==========================================
  // 5. WRITE TO GOOGLE SHEET (เขียนทับทั้งชีทตามลำดับเวลาเช้าไปเย็น)
  // ==========================================

  const lastSync = rocket.formatDateTimeBangkok(new Date());
  const rows = tomorrowTickets.map(function(r) {
    return planToRow(r, lastSync);
  });

  const fullHeaders = PLAN_HEADERS.concat(['Ticket ID']);
  await sheetsLib.replaceSheetData(sheets, spreadsheetId, sheetId, PLAN_SHEET_NAME, fullHeaders, rows);

  console.log('เขียนแล้ว ' + rows.length + '/' + tomorrowTickets.length + ' (เรียงตามเวลานัดหมาย เช้า ➔ เย็น)');
  console.log('DONE');

}

main().catch(function(err) {
  console.error('Sync ล้มเหลว:', err);
  process.exit(1);
});
