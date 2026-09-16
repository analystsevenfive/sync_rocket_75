/*************************************************
 * SYNC DAILY REPAIR UPDATE
 *
 * รายงานตั๋วที่มี "วันที่นัดหมาย" (appointment) ตรงกับ
 * "วันนี้" เสมอ (ตามเวลากรุงเทพ)
 *
 * คอลัมน์ (Header ภาษาอังกฤษ):
 *   Ticket ID, Ticket No, Report Date, Appointment, End Time,
 *   Inspection Status, Sales Invoice No., Customer, Branch, Contact, Phone,
 *   Problem Reported, Product Name, Technician, Team, Serial,
 *   URL, Last Sync
 *************************************************/

const rocket = require('./lib/rocket-client');
const sheetsLib = require('./lib/sheets-client');

const SHEET_NAME = 'Daily Repair Update';
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
  'Active Stage',
  'Status 1',
  'Status 2',
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
  return [
    d.ticketId,
    d.ticketNo,
    d.reportDate || '',
    d.appointment,
    d.endTime || '',
    d.inspectionStatus || '',
    d.activeStage || '',
    d.status1 || '',
    d.status2 || '',
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



function extractParentToStatusesMap(html) {
  const map = {};
  if (!html || typeof html !== 'string') {
    return map;
  }

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rHtml = rowMatch[1];
    const pMatch = rHtml.match(/ticket_view\.php\?id=(\d+)/i);
    if (!pMatch) continue;
    const parentId = pMatch[1];

    const ticketNoMatch = rHtml.match(/([A-Z]{2,4}[0-9]{4}-[0-9]+)/i);
    const parentTicketNo = ticketNoMatch ? ticketNoMatch[1] : '';

    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let cm;
    while ((cm = cellRegex.exec(rHtml)) !== null) {
      cells.push(cm[1]);
    }

    if (cells.length > 4) {
      const statusCell = cells[4];
      const badgeRegex = /<(?:span|label|div)[^>]*class=["'][^"']*badge[^"']*["'][^>]*>([\s\S]*?)<\/(?:span|label|div)>/gi;
      let badgeMatch;
      const statuses = [];
      while ((badgeMatch = badgeRegex.exec(statusCell)) !== null) {
        const text = rocket.cleanText(badgeMatch[1].replace(/<[^>]+>/g, ''));
        if (text) statuses.push(text);
      }
      if (statuses.length === 0) {
        const lines = statusCell
          .split(/<br\s*\/?>/i)
          .map(function(s) { return rocket.cleanText(s.replace(/<[^>]+>/g, '')); })
          .filter(Boolean);
        statuses.push(...lines);
      }

      if (statuses.length > 0) {
        map[parentId] = statuses;
        if (parentTicketNo) {
          map[parentTicketNo] = statuses;
        }
      }
    }
  }

  return map;
}



async function main() {

  console.log('========== DAILY REPAIR UPDATE SYNC (Node.js / GitHub Actions) ==========');

  const auth = await rocket.rocketLogin();
  console.log('LOGIN OK');

  const range = rocket.computeTodayRangeBangkok();
  console.log('วันที่นัดหมาย (วันนี้): ' + range.start);

  // ==========================================
  // 1. PARENT TICKETS ที่มีนัดหมายวันนี้ (date_type=2)
  // ==========================================

  const parentHtml = await rocket.getParentTicketHtml(auth, range.start, range.end, DATE_TYPE_APPOINTMENT);
  const parentIds = rocket.extractParentTicketIds(parentHtml);
  const parentToProductMap = rocket.extractParentToProductIdMap(parentHtml);
  const parentToCustomerCodeMap = rocket.extractParentToCustomerCodeMap(parentHtml);
  const parentToStatusesMap = extractParentToStatusesMap(parentHtml);
  console.log('PARENT TICKETS ที่พบจากการค้นหา: ' + parentIds.length + ' (แมป Product ID ได้: ' + Object.keys(parentToProductMap).length + ', Customer Code ได้: ' + Object.keys(parentToCustomerCodeMap).length + ', Statuses ได้: ' + Object.keys(parentToStatusesMap).length + ')');

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
  // 3. FETCH DETAIL + FILTER เฉพาะตั๋วที่นัดหมายตรงกับวันนี้จริงๆ
  // ==========================================

  let todayTickets = [];

  if (candidateSubIds.length > 0) {
    const detailResults = await rocket.mapConcurrentStrict(candidateSubIds, SUB_CONCURRENCY, async function(subId) {
      const html = await rocket.getTicketDetailHtml(subId, auth);
      const ticket = rocket.parseTicketDetail(html, subId);
      if (!ticket.ticketNo && !ticket.status) {
        throw new Error('หน้าที่ได้ไม่ใช่ ticket detail จริง (parse ไม่สำเร็จ)');
      }
      const info = infoMap[String(subId)] || (ticket.ticketNo ? infoMap[ticket.ticketNo] : null) || {};
      ticket.technician = info.technicians || ticket.technician || '';
      ticket.team = info.team || '';
      ticket.status2 = info.status || '';
      return ticket;
    });

    detailResults.forEach(function(r, i) {
      if (r && r.__error) {
        console.log('ERROR SubTicket ' + candidateSubIds[i] + ': ' + r.__error);
      } else if (r) {
        if (rocket.isMatchingDateParts(r.appointment, range.dateParts)) {
          todayTickets.push(r);
        } else {
          console.log('ข้ามตั๋ว ' + (r.ticketNo || r.ticketId) + ' (นัดหมาย: "' + (r.appointment || 'ไม่มี') + '" ไม่ใช่วันนี้)');
        }
      }
    });
  }

  console.log('SUB TICKETS ที่มีนัดหมายตรงกับวันนี้จริง: ' + todayTickets.length);

  if (parentIds.length > 0 && candidateSubIds.length > 0 && todayTickets.length === 0) {
    throw new Error('พบ parent/sub tickets แต่ไม่พบ appointment ที่ตรงกับวันที่ ' + range.start +
      ' — หยุดก่อนล้างชีท; ตรวจสอบรูปแบบวันที่ใน ticket detail หรือ date filter ของ Rocket');
  }

  todayTickets.forEach(function(t) {
    const parentNo = (t.parentTicketNo || (t.ticketNo ? t.ticketNo.replace(/\.[A-Z0-9]+$/i, '') : '')).trim();
    t.customerCode = t.customerCode ||
                     parentToCustomerCodeMap[String(t.parentTicketId)] ||
                     parentToCustomerCodeMap[parentNo] ||
                     '';
  });

  // ==========================================
  // 4. FETCH INSPECTION STATUS, ACTIVE STAGE & SALES INVOICE (ดูการตรวจงาน, Active Stage & เลขที่บิลขาย)
  // ==========================================

  if (todayTickets.length > 0) {
    console.log('กำลังดึงสถานะการตรวจงาน & Active Stage (ModalView_inspector)...');
    const subIdsToFetch = [...new Set(todayTickets.map(function(t) {
      return t.ticketId;
    }).filter(Boolean))];

    const inspectorMap = {};
    await rocket.mapConcurrentStrict(subIdsToFetch, INSPECTOR_CONCURRENCY, async function(subId) {
      const modalHtml = await rocket.getInspectorModalHtml(subId, auth);
      const parsed = rocket.parseInspectorModal(modalHtml);
      inspectorMap[String(subId)] = parsed;
    });

    todayTickets.forEach(function(t) {
      const sid = String(t.ticketId);
      const insp = inspectorMap[sid] || {};
      t.inspectionStatus = insp.status || '';
      t.activeStage = insp.type || '';
    });

    // Fallback: สำหรับตั๋วที่ยังไม่มี type ใน inspector modal ให้ดึงจาก ticket_view.php?id=<parentId>
    const missingStageParents = [...new Set(todayTickets
      .filter(function(t) { return !t.activeStage && (t.parentTicketId || t.ticketId); })
      .map(function(t) { return t.parentTicketId || t.ticketId; }))];

    const parentOverallStatusMap = {};
    if (missingStageParents.length > 0) {
      console.log('กำลังดึง Active Stage เพิ่มเติมจาก ticket_view สำหรับ ' + missingStageParents.length + ' parent tickets...');
      const parentStageMap = {};
      await rocket.mapConcurrentStrict(missingStageParents, 20, async function(parentId) {
        const pHtml = await rocket.getParentPageHtml(parentId, auth);
        parentStageMap[String(parentId)] = rocket.parseCurrentJobType(pHtml);
        parentOverallStatusMap[String(parentId)] = rocket.extractTicketStatus(pHtml);
      });

      todayTickets.forEach(function(t) {
        if (!t.activeStage) {
          const pid = String(t.parentTicketId || t.ticketId);
          t.activeStage = parentStageMap[pid] || '';
        }
      });
    }

    // แมป Status 1 และ Status 2
    todayTickets.forEach(function(t) {
      const parentNo = (t.parentTicketNo || (t.ticketNo ? t.ticketNo.replace(/\.[A-Z0-9]+$/i, '') : '')).trim();
      const pStatuses = parentToStatusesMap[String(t.parentTicketId)] ||
                        parentToStatusesMap[parentNo] ||
                        [];

      // Status 1: จากหน้าใบงานย่อย (ticket.status) หรือ fallback จาก badge ตัวแรกของ parent
      const validSubStatus = (t.status && t.status.toLowerCase() !== 'active') ? t.status : '';
      const validP0 = (pStatuses[0] && pStatuses[0].toLowerCase() !== 'active') ? pStatuses[0] : '';
      t.status1 = validSubStatus || validP0 || '';

      // Status 2: จาก checkrepair.php (infoMap) หรือ fallback จาก badge ตัวที่สองของ parent
      if (!t.status2) {
        const sid = String(t.ticketId);
        const tNo = t.ticketNo || '';
        const info = infoMap[sid] || (tNo ? infoMap[tNo] : null);
        if (info && info.status) {
          t.status2 = info.status;
        }
      }
      if (t.status2 && t.status2.toLowerCase() === 'active') {
        t.status2 = '';
      }
      const validP1 = (pStatuses[1] && pStatuses[1].toLowerCase() !== 'active') ? pStatuses[1] : '';
      t.status2 = t.status2 || validP1 || '';
    });

    // แมป parentTicketId -> productId
    todayTickets.forEach(function(t) {
      if (t.parentTicketId && parentToProductMap[String(t.parentTicketId)]) {
        t.productId = parentToProductMap[String(t.parentTicketId)];
      }
    });

    // ดึงเลขที่บิลขาย (ModalProduct.php) จาก product_id
    const productIdsToFetch = [...new Set(todayTickets.map(function(t) {
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

    todayTickets.forEach(function(t) {
      const pid = t.productId ? String(t.productId) : '';
      t.salesInvoiceNo = productInvoiceMap[pid] || '';
    });
  }


  // ==========================================
  // 5. SORT BY APPOINTMENT (จัดเรียงจากเช้า ไปเย็น)
  // ==========================================

  todayTickets.sort(function(a, b) {
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
  const rows = todayTickets.map(function(r) {
    return jobToRow(r, lastSync);
  });

  await sheetsLib.replaceSheetData(sheets, spreadsheetId, sheetId, SHEET_NAME, HEADERS, rows);

  console.log('เขียนแล้ว ' + rows.length + '/' + todayTickets.length + ' (เรียงตามเวลานัดหมาย เช้า ➔ เย็น)');
  console.log('DONE');

}

main().catch(function(err) {
  console.error('Sync ล้มเหลว:', err);
  process.exit(1);
});
