/*************************************************
 * SYNC TICKETS — Node.js port ของ syncRocket75()
 * (trick.js) รวม incremental skip-if-closed + prune
 * ที่เพิ่งทำบน Apps Script ด้วย
 *
 * ทดสอบผ่านแล้วบนชีท "Tickets (Test)" — Apps Script
 * trigger เดิมปิดไปแล้ว จึงสลับมาเขียนชีท "Tickets" จริง
 *************************************************/

const rocket = require('./lib/rocket-client');
const sheetsLib = require('./lib/sheets-client');

const TICKETS_SHEET_NAME = 'Tickets';

const PARENT_CONCURRENCY = 30;
const SUB_CONCURRENCY = 30;
const INSPECTOR_CONCURRENCY = 25;
const PRODUCT_CONCURRENCY = 20;

const TICKET_HEADERS = [
  'Inspection Status', 'Sales Invoice No.',
  'Ticket ID', 'Parent Ticket ID', 'Parent Ticket No', 'Ticket No', 'Status', 'Appointment',
  'Report Date', 'Customer', 'Branch', 'Contact', 'Phone',
  'Problem Reported', 'Work Description', 'Special Condition', 'Note', 'Machine Location',
  'Product Code', 'Product Name', 'Power Type', 'Serial', 'Warranty',
  'Start Time', 'End Time', 'Duration Min', 'Time Recorder',
  'Repair Result', 'Customer Symptom', 'Cause Found', 'Solution', 'Repair Note',
  'Part Failure Cause', 'Technician',
  'URL', 'Last Sync'
];



// เหมือน forceTextIfNumeric_ ใน trick.js — กันเบอร์โทร
// เลข 0 นำหน้าหายตอน USER_ENTERED ตีความเป็น number
function forceTextIfNumeric(value) {
  if (value === null || value === undefined || value === '') {
    return value;
  }
  const str = String(value);
  return /^\d+$/.test(str) ? "'" + str : str;
}



function ticketToRow(d, lastSync) {
  return [
    d.inspectionStatus || '', forceTextIfNumeric(d.salesInvoiceNo),
    d.ticketId, d.parentTicketId, d.parentTicketNo, d.ticketNo, d.status, d.appointment,
    d.reportDate, d.customer, d.branch, d.contact, forceTextIfNumeric(d.phone),
    d.problem, d.workDescription, d.specialCondition, d.note, d.machineLocation,
    d.productCode, d.productName, d.powerType, d.serial, d.warranty,
    d.startTime, d.endTime, d.duration, d.timeRecorder,
    d.repairResult, d.customerSymptom, d.causeFound, d.solution, d.repairNote,
    d.partFailureCause, d.technician,
    d.url, lastSync
  ];
}



async function main() {

  console.log('========== TICKETS SYNC (Node.js / GitHub Actions) ==========');

  const auth = await rocket.rocketLogin();
  console.log('LOGIN OK');

  const range = rocket.computeLast3MonthsRangeBangkok();
  console.log('ช่วงวันที่: ' + range.start + ' - ' + range.end);

  // ==========================================
  // 1. PARENT TICKETS
  // ==========================================

  const parentHtml = await rocket.getParentTicketHtml(auth, range.start, range.end);
  const parentIds = rocket.extractParentTicketIds(parentHtml);
  const parentToProductMap = rocket.extractParentToProductIdMap(parentHtml);
  console.log('PARENT TICKETS: ' + parentIds.length + ' (แมป Product ID ได้: ' + Object.keys(parentToProductMap).length + ')');

  if (parentIds.length === 0) {
    throw new Error('พบ 0 parent ticket — น่าจะเป็น fetch/parse ผิดพลาดชั่วคราว ไม่ใช่ข้อมูลจริง หยุดก่อน');
  }

  // ==========================================
  // 2. SUB TICKETS (checkrepair.php ต่อ parent)
  // ==========================================

  const checkRepairResults = await rocket.mapConcurrent(parentIds, PARENT_CONCURRENCY, async function(parentId) {
    const html = await rocket.getCheckRepairHtml(parentId, auth);
    return rocket.extractCheckRepairIds(html);
  });

  let subIds = [];
  checkRepairResults.forEach(function(r, i) {
    if (r && r.__error) {
      console.log('ERROR Parent ' + parentIds[i] + ': ' + r.__error);
    } else if (Array.isArray(r)) {
      subIds = subIds.concat(r);
    }
  });
  subIds = [...new Set(subIds)];
  console.log('SUB TICKETS: ' + subIds.length);

  if (subIds.length === 0) {
    throw new Error('พบ 0 sub ticket ทั้งที่มี ' + parentIds.length + ' parent ticket — น่าจะเป็น fetch/parse ผิดพลาดชั่วคราว');
  }

  // ==========================================
  // 3. FETCH DETAIL (ทุกใบ ไม่ข้าม — sync สดใหม่ทุกรอบ)
  // ==========================================

  console.log('กำลังดึงรายละเอียดตั๋วทั้งหมด ' + subIds.length + ' ใบ (sync สดใหม่ทุกรายการ)...');
  const detailResults = await rocket.mapConcurrent(subIds, SUB_CONCURRENCY, async function(subId) {
    const html = await rocket.getTicketDetailHtml(subId, auth);
    const ticket = rocket.parseTicketDetail(html, subId);
    if (!ticket.ticketNo && !ticket.status) {
      throw new Error('หน้าที่ได้ไม่ใช่ ticket detail จริง (parse ไม่สำเร็จ)');
    }
    return ticket;
  });

  const validTickets = [];
  detailResults.forEach(function(r, i) {
    if (r && r.__error) {
      console.log('ERROR SubTicket ' + subIds[i] + ': ' + r.__error);
    } else if (r) {
      validTickets.push(r);
    }
  });

  // ==========================================
  // 4. FETCH INSPECTION STATUS & SALES INVOICE
  // ==========================================

  if (validTickets.length > 0) {
    console.log('กำลังดึงสถานะการตรวจงาน (ModalView_inspector)...');
    const inspectorMap = {};
    await rocket.mapConcurrent(validTickets.map(t => t.ticketId), INSPECTOR_CONCURRENCY, async function(subId) {
      try {
        const modalHtml = await rocket.getInspectorModalHtml(subId, auth);
        const parsed = rocket.parseInspectorModal(modalHtml);
        inspectorMap[String(subId)] = parsed;
      } catch (e) {
        // ignore
      }
    });

    validTickets.forEach(function(t) {
      const sid = String(t.ticketId);
      const insp = inspectorMap[sid] || {};
      t.inspectionStatus = insp.status || '';
    });

    // แมป parentTicketId -> productId
    validTickets.forEach(function(t) {
      if (t.parentTicketId && parentToProductMap[String(t.parentTicketId)]) {
        t.productId = parentToProductMap[String(t.parentTicketId)];
      }
    });

    // ดึงเลขที่บิลขาย (ModalProduct.php) จาก product_id
    const productIdsToFetch = [...new Set(validTickets.map(t => t.productId).filter(Boolean))];
    console.log('กำลังดึงเลขที่บิลขาย (ModalProduct.php) สำหรับ ' + productIdsToFetch.length + ' รายการ...');
    const productInvoiceMap = {};
    if (productIdsToFetch.length > 0) {
      await rocket.mapConcurrent(productIdsToFetch, PRODUCT_CONCURRENCY, async function(prodId) {
        try {
          const prodHtml = await rocket.getModalProductHtml(prodId, auth);
          const invoiceNo = rocket.parseSalesInvoiceNo(prodHtml);
          productInvoiceMap[String(prodId)] = invoiceNo;
        } catch (e) {
          // ignore
        }
      });
    }

    validTickets.forEach(function(t) {
      const pid = t.productId ? String(t.productId) : '';
      t.salesInvoiceNo = productInvoiceMap[pid] || '';
    });
  }

  // ==========================================
  // 5. บันทึกลง GOOGLE SHEETS ด้วย replaceSheetDataWithSummary
  // ==========================================

  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new Error('ไม่พบ SPREADSHEET_ID ใน environment variables');
  }
  const sheets = await sheetsLib.getSheetsClient();
  const sheetId = await sheetsLib.ensureSheetExists(sheets, spreadsheetId, TICKETS_SHEET_NAME);

  const lastSync = rocket.formatDateTimeBangkok(new Date());
  const rows = validTickets.map(function(t) {
    return ticketToRow(t, lastSync);
  });

  const summaryText = 'ช่วงข้อมูล ' + range.start + ' - ' + range.end + ' | จำนวน ' + rows.length.toLocaleString('en-US') + ' รายการ';
  await sheetsLib.replaceSheetDataWithSummary(sheets, spreadsheetId, sheetId, TICKETS_SHEET_NAME, summaryText, TICKET_HEADERS, rows);

  console.log('เขียนลงชีท \'' + TICKETS_SHEET_NAME + '\' สำเร็จ: ' + rows.length + ' แถว (' + summaryText + ')');
  console.log('DONE');

}

main().catch(function(err) {
  console.error('Sync ล้มเหลว:', err);
  process.exit(1);
});
