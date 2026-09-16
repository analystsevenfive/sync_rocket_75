/*************************************************
 * SYNC YESTERDAY'S COMPLETED JOBS
 *
 * รายงานตั๋วที่มี "วันที่นัดหมาย" (appointment) ตรงกับ
 * วันเมื่อวานเสมอ (ตามเวลากรุงเทพ)
 *
 * คอลัมน์ (Header ภาษาอังกฤษ):
 *   Ticket ID, Ticket No, Report Date, Appointment, End Time,
 *   Inspection Status, Sales Invoice No., Customer, Branch, Contact, Phone,
 *   Problem Reported, Product Name, Technician, Team, Serial,
 *   URL, Last Sync
 *************************************************/

const rocket = require('./lib/rocket-client');
const sheetsLib = require('./lib/sheets-client');

// override ได้ผ่าน env var สำหรับรัน test เข้าชีทแยกต่างหาก
// (เช่น 'Yesterday’s Completed Jobs Test')
const SHEET_NAME = process.env.YESTERDAY_JOBS_SHEET_NAME_OVERRIDE || 'Yesterday’s Completed Jobs';
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
  'Working Time',
  'Inspection Status',
  'Active Stage',
  'Sales Invoice No.',
  'Customer',
  'Branch',
  'Customer Code',
  'Contact',
  'Phone',
  'Problem Reported',
  'Product Code',
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
  const workingTime = d.workingTime || rocket.computeWorkingTime(d.reportDate, d.endTime);
  return [
    d.ticketId,
    d.ticketNo,
    d.reportDate || '',
    d.appointment,
    d.endTime || '',
    workingTime ? "'" + workingTime : '',
    d.inspectionStatus || '',
    d.activeStage || '',
    forceTextIfNumeric(d.salesInvoiceNo),
    d.customer,
    d.branch,
    forceTextIfNumeric(d.customerCode),
    d.contact,
    forceTextIfNumeric(d.phone),
    d.problem,
    forceTextIfNumeric(d.productCode),
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

  let range;
  if (process.env.TARGET_DATE_OVERRIDE) {
    let rawDate = String(process.env.TARGET_DATE_OVERRIDE).trim();
    // ถ้าใส่มาแค่ D/M หรือ DD/MM เช่น 3/9 ให้เติมปีปัจจุบันอัตโนมัติ
    if (/^\d{1,2}[/-]\d{1,2}$/.test(rawDate)) {
      const nowYear = new Date().getFullYear();
      rawDate = rawDate + '/' + nowYear;
    }
    const parts = rocket.parseDateParts(rawDate);
    if (!parts) {
      throw new Error('TARGET_DATE_OVERRIDE format ไม่ถูกต้อง: ' + process.env.TARGET_DATE_OVERRIDE);
    }
    const fmtStr = String(parts.day).padStart(2, '0') + '/' + String(parts.month).padStart(2, '0') + '/' + parts.year;
    range = { start: fmtStr, end: fmtStr, dateParts: parts };
    console.log('วันที่นัดหมาย (override): ' + range.start);
  } else {
    range = rocket.computeYesterdayRangeBangkok();
    console.log('วันที่นัดหมาย (เมื่อวาน): ' + range.start);
  }

  // ==========================================
  // 1. PARENT TICKETS ที่มีนัดหมาย (date_type=2)
  // ==========================================

  const parentHtml = await rocket.getParentTicketHtml(auth, range.start, range.end, DATE_TYPE_APPOINTMENT);
  const parentIds = rocket.extractParentTicketIds(parentHtml);
  const parentToProductMap = rocket.extractParentToProductIdMap(parentHtml);
  const parentToCustomerCodeMap = rocket.extractParentToCustomerCodeMap(parentHtml);
  console.log('PARENT TICKETS ที่พบจากการค้นหา: ' + parentIds.length + ' (แมป Product ID ได้: ' + Object.keys(parentToProductMap).length + ', Customer Code ได้: ' + Object.keys(parentToCustomerCodeMap).length + ')');


  // ==========================================
  // 2. CANDIDATE SUB TICKETS + ช่าง/ทีม ต่อ parent
  // ==========================================

  let candidateSubIds = [];
  let infoMap = {};

  if (parentIds.length > 0) {
    const checkRepairResults = await rocket.mapConcurrentStrict(parentIds, PARENT_CONCURRENCY, async function(parentId) {
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

  if (parentIds.length > 0 && candidateSubIds.length === 0) {
    throw new Error('พบ ' + parentIds.length + ' parent tickets แต่ไม่พบ sub tickets เลย — ตรวจสอบการเชื่อมต่อหรือโครงสร้างหน้า checkrepair.php หยุดก่อนเพื่อป้องกันข้อมูลในชีทถูกล้าง');
  }

  // ==========================================
  // 3. FETCH DETAIL + FILTER เฉพาะตั๋วที่นัดหมายตรงกับวันเมื่อวานจริงๆ
  // ==========================================

  let yesterdayTickets = [];

  if (candidateSubIds.length > 0) {
    const detailResults = await rocket.mapConcurrentStrict(candidateSubIds, SUB_CONCURRENCY, async function(subId) {
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

  if (parentIds.length > 0 && candidateSubIds.length > 0 && yesterdayTickets.length === 0) {
    throw new Error('พบ parent/sub tickets แต่ไม่พบ appointment ที่ตรงกับวันที่ ' + range.start +
      ' — หยุดก่อนล้างชีท; ตรวจสอบรูปแบบวันที่ใน ticket detail หรือ date filter ของ Rocket');
  }

  yesterdayTickets.forEach(function(t) {
    const parentNo = (t.parentTicketNo || (t.ticketNo ? t.ticketNo.replace(/\.[A-Z0-9]+$/i, '') : '')).trim();
    t.customerCode = t.customerCode ||
                     parentToCustomerCodeMap[String(t.parentTicketId)] ||
                     parentToCustomerCodeMap[parentNo] ||
                     '';
  });

  // ==========================================
  // 4. FETCH INSPECTION STATUS, ACTIVE STAGE & SALES INVOICE (ดูการตรวจงาน, Active Stage & เลขที่บิลขาย)
  // ==========================================

  if (yesterdayTickets.length > 0) {
    console.log('กำลังดึงสถานะการตรวจงาน & Active Stage (ModalView_inspector)...');
    const subIdsToFetch = [...new Set(yesterdayTickets.map(function(t) {
      return t.ticketId;
    }).filter(Boolean))];

    const inspectorMap = {};
    await rocket.mapConcurrentStrict(subIdsToFetch, INSPECTOR_CONCURRENCY, async function(subId) {
      const modalHtml = await rocket.getInspectorModalHtml(subId, auth);
      const parsed = rocket.parseInspectorModal(modalHtml);
      inspectorMap[String(subId)] = parsed;
    });

    yesterdayTickets.forEach(function(t) {
      const sid = String(t.ticketId);
      const insp = inspectorMap[sid] || {};
      t.inspectionStatus = insp.status || '';
      t.activeStage = insp.type || '';
    });

    // Fallback: สำหรับตั๋วที่ยังไม่มี type ใน inspector modal ให้ดึงจาก ticket_view.php?id=<parentId>
    const missingStageParents = [...new Set(yesterdayTickets
      .filter(function(t) { return !t.activeStage && (t.parentTicketId || t.ticketId); })
      .map(function(t) { return t.parentTicketId || t.ticketId; }))];

    if (missingStageParents.length > 0) {
      console.log('กำลังดึง Active Stage เพิ่มเติมจาก ticket_view สำหรับ ' + missingStageParents.length + ' parent tickets...');
      const parentStageMap = {};
      await rocket.mapConcurrentStrict(missingStageParents, 20, async function(parentId) {
        const pHtml = await rocket.getParentPageHtml(parentId, auth);
        parentStageMap[String(parentId)] = rocket.parseCurrentJobType(pHtml);
      });

      yesterdayTickets.forEach(function(t) {
        if (!t.activeStage) {
          const pid = String(t.parentTicketId || t.ticketId);
          t.activeStage = parentStageMap[pid] || '';
        }
      });
    }

    // แมป parentTicketId -> productId
    yesterdayTickets.forEach(function(t) {
      if (t.parentTicketId && parentToProductMap[String(t.parentTicketId)]) {
        t.productId = parentToProductMap[String(t.parentTicketId)];
      }
    });

    // ดึงเลขที่บิลขาย (ModalProduct.php) จาก product_id
    const productIdsToFetch = [...new Set(yesterdayTickets.map(function(t) {
      return t.productId;
    }).filter(Boolean))];

    console.log('กำลังดึงเลขที่บิลขาย (ModalProduct.php) สำหรับ ' + productIdsToFetch.length + ' รายการ...');
    const productInvoiceMap = {};
    if (productIdsToFetch.length > 0) {
      await rocket.mapConcurrentStrict(productIdsToFetch, 20, async function(prodId) {
        const prodHtml = await rocket.getModalProductHtml(prodId, auth);
        const invoiceNo = rocket.parseSalesInvoiceNo(prodHtml);
        productInvoiceMap[String(prodId)] = invoiceNo;
      });
    }

    yesterdayTickets.forEach(function(t) {
      const pid = t.productId ? String(t.productId) : '';
      t.salesInvoiceNo = productInvoiceMap[pid] || '';
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
