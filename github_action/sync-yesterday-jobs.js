/*************************************************
 * SYNC YESTERDAY'S COMPLETED JOBS
 *
 * รายงานตั๋วที่มี "วันที่นัดหมาย" (appointment) ตรงกับ
 * วันเมื่อวานเสมอ (ตามเวลากรุงเทพ)
 *
 * คอลัมน์ (Header ภาษาอังกฤษ):
 *   Ticket ID, Ticket No, Report Date, Appointment, End Time,
 *   Inspection Status, Customer, Branch, Contact, Phone,
 *   Problem Reported, Product Name, Technician, Team, Serial,
 *   URL, Last Sync
 *************************************************/

const rocket = require('./lib/rocket-client');
const sheetsLib = require('./lib/sheets-client');

const SHEET_NAME = 'Yesterday’s Completed Jobs';
const DATE_TYPE_APPOINTMENT = '2';

const PARENT_CONCURRENCY = 30;
const SUB_CONCURRENCY = 30;
const INSPECTOR_CONCURRENCY = 20;

const HEADERS = [
  'Ticket ID',
  'Ticket No',
  'Report Date',
  'Appointment',
  'End Time',
  'Inspection Status',
  'Customer',
  'Branch',
  'Contact',
  'Phone',
  'Problem Reported',
  'Product Name',
  'Technician',
  'Team',
  'Serial',
  'URL',
  'Last Sync'
];



function forceTextIfNumeric(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  const str = String(value).trim();
  return /^\d+$/.test(str) ? "'" + str : str;
}



function jobToRow(d, lastSync) {
  return [
    d.ticketId,
    d.ticketNo,
    d.reportDate || '',
    d.appointment,
    d.endTime || '',
    d.inspectionStatus || '',
    d.customer,
    d.branch,
    d.contact,
    forceTextIfNumeric(d.phone),
    d.problem,
    d.productName,
    d.technician,
    d.team || '',
    forceTextIfNumeric(d.serial),
    d.url,
    lastSync
  ];
}



async function main() {

  console.log('========== YESTERDAY COMPLETED JOBS SYNC (Node.js / GitHub Actions) ==========');

  const auth = await rocket.rocketLogin();
  console.log('LOGIN OK');

  const range = rocket.computeYesterdayRangeBangkok();
  console.log('วันที่นัดหมาย (เมื่อวาน): ' + range.start);

  // ==========================================
  // 1. PARENT TICKETS ที่มีนัดหมายเมื่อวาน (date_type=2)
  // ==========================================

  const parentHtml = await rocket.getParentTicketHtml(auth, range.start, range.end, DATE_TYPE_APPOINTMENT);
  const parentIds = rocket.extractParentTicketIds(parentHtml);
  console.log('PARENT TICKETS ที่พบจากการค้นหา: ' + parentIds.length);

  // ==========================================
  // 2. CANDIDATE SUB TICKETS + ช่าง/ทีม ต่อ parent
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
  // 3. FETCH DETAIL + FILTER เฉพาะตั๋วที่นัดหมายตรงกับวันเมื่อวานจริงๆ
  // ==========================================

  let yesterdayTickets = [];

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
          yesterdayTickets.push(r);
        } else {
          console.log('ข้ามตั๋ว ' + (r.ticketNo || r.ticketId) + ' (นัดหมาย: "' + (r.appointment || 'ไม่มี') + '" ไม่ใช่วันเมื่อวาน)');
        }
      }
    });
  }

  console.log('SUB TICKETS ที่มีนัดหมายตรงกับวันเมื่อวานจริง: ' + yesterdayTickets.length);

  // ==========================================
  // 4. FETCH INSPECTION STATUS (ดูการตรวจงาน)
  // ==========================================

  if (yesterdayTickets.length > 0) {
    console.log('กำลังดึงสถานะการตรวจงาน (ModalView_inspector)...');
    const parentIdsToFetch = [...new Set(yesterdayTickets.map(function(t) {
      return t.parentTicketId || t.ticketId;
    }).filter(Boolean))];

    const inspectorMap = {};
    await rocket.mapConcurrent(parentIdsToFetch, INSPECTOR_CONCURRENCY, async function(parentId) {
      const modalHtml = await rocket.getInspectorModalHtml(parentId, auth);
      const parsed = rocket.parseInspectorModal(modalHtml);
      inspectorMap[String(parentId)] = parsed;
    });

    yesterdayTickets.forEach(function(t) {
      const pid = String(t.parentTicketId || t.ticketId);
      const insp = inspectorMap[pid] || {};
      t.inspectionStatus = insp.status || '';
    });
  }

  // ==========================================
  // 5. SORT BY APPOINTMENT (จัดเรียงจากเช้า ไปเย็น)
  // ==========================================

  yesterdayTickets.sort(function(a, b) {
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

  const sheetId = await sheetsLib.ensureSheetExists(sheets, spreadsheetId, SHEET_NAME);

  // ==========================================
  // 6. WRITE TO GOOGLE SHEET (เขียนทับทั้งชีทตามลำดับเวลาเช้าไปเย็น)
  // ==========================================

  const lastSync = rocket.formatDateTimeBangkok(new Date());
  const rows = yesterdayTickets.map(function(r) {
    return jobToRow(r, lastSync);
  });

  await sheetsLib.replaceSheetData(sheets, spreadsheetId, sheetId, SHEET_NAME, HEADERS, rows);

  console.log('เขียนแล้ว ' + rows.length + '/' + yesterdayTickets.length + ' (เรียงตามเวลานัดหมาย เช้า ➔ เย็น)');
  console.log('DONE');

}

main().catch(function(err) {
  console.error('Sync ล้มเหลว:', err);
  process.exit(1);
});
