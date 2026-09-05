/*************************************************
 * SYNC 7-DAY INSTALLATION PLAN
 *
 * รายงานแผนงานติดตั้งประจำวันระยะเวลา 7 วัน (Appointment today + 7 วันข้างหน้า)
 * ตามเวลากรุงเทพ (UTC+7)
 *
 * แหล่งข้อมูล: Rocket75 (search_type=3 สำหรับงานติดตั้ง IN, date_type=2 สำหรับวันที่นัดหมาย)
 * คอลัมน์ (Header ภาษาอังกฤษ):
 *   Ticket No, Salesperson, Report Date, Appointment Date, Appointment Time,
 *   Brand, Model, Product Description, Customer, Branch, Location, Type,
 *   Note, URL, Last Sync
 *
 * เขียนลงชีท: 7-Day Installation Plan
 *************************************************/

const rocket = require('./lib/rocket-client');
const sheetsLib = require('./lib/sheets-client');

const SHEET_NAME = '7-Day Installation Plan';
const DATE_TYPE_APPOINTMENT = '2';
const SEARCH_TYPE_INSTALLATION = '3'; // IN = งานติดตั้ง

const PARENT_CONCURRENCY = 30;
const SUB_CONCURRENCY = 30;

const HEADERS = [
  'Ticket No',
  'Salesperson',
  'Report Date',
  'Appointment Date',
  'Appointment Time',
  'Brand',
  'Model',
  'Product Description',
  'Customer',
  'Branch',
  'Location',
  'Type',
  'Note',
  'URL',
  'Last Sync'
];

/**
 * คำนวณช่วงวันที่ วันนี้ ถึง วันนี้ + 7 วัน (เวลาประเทศไทย UTC+7)
 */
function compute7DayPlanRangeBangkok() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const bkkNow = new Date(utc + (7 * 3600000));

  const startYear = bkkNow.getFullYear();
  const startMonth = bkkNow.getMonth() + 1;
  const startDay = bkkNow.getDate();

  const endDateObj = new Date(bkkNow);
  endDateObj.setDate(endDateObj.getDate() + 7);
  const endYear = endDateObj.getFullYear();
  const endMonth = endDateObj.getMonth() + 1;
  const endDay = endDateObj.getDate();

  const pad = n => String(n).padStart(2, '0');

  return {
    start: `${pad(startDay)}/${pad(startMonth)}/${startYear}`,
    end: `${pad(endDay)}/${pad(endMonth)}/${endYear}`,
    startDateObj: new Date(startYear, startMonth - 1, startDay, 0, 0, 0),
    endDateObj: new Date(endYear, endMonth - 1, endDay, 23, 59, 59)
  };
}

/**
 * แยกวันที่และเวลาจากสตริงนัดหมายของ Rocket75
 * รองรับทั้ง DD/MM/YYYY (พ.ศ. / ค.ศ.) และ DD Mon YYYY
 */
function parseAppointment(appointmentStr) {
  if (!appointmentStr || typeof appointmentStr !== 'string') {
    return { dateStr: '', timeStr: '', dateObj: null, timestamp: 0 };
  }

  const text = appointmentStr.trim();
  let day = 0;
  let month = 0;
  let year = 0;
  let hour = 0;
  let minute = 0;

  // 1. ตรวจสอบวันที่รูปแบบ DD/MM/YYYY หรือ D/M/YYYY
  const m1 = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m1) {
    day = parseInt(m1[1], 10);
    month = parseInt(m1[2], 10);
    year = parseInt(m1[3], 10);
    if (year > 2400) year -= 543; // แปลง พ.ศ. เป็น ค.ศ.
  } else {
    // 2. ตรวจสอบวันที่รูปแบบ 07 Sep 2026 หรือ 7 Sep 2026
    const MONTH_MAP = {
      jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
      jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
    };
    const m2 = text.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/i);
    if (m2) {
      day = parseInt(m2[1], 10);
      month = MONTH_MAP[m2[2].toLowerCase()] || 0;
      year = parseInt(m2[3], 10);
      if (year > 2400) year -= 543;
    }
  }

  // 3. ตรวจสอบเวลา (เช่น 08:00, 08.00, 08.00น.)
  let timeStr = '';
  const tm = text.match(/(\d{1,2})[:.](\d{2})(?:\s*น\.?)?/);
  if (tm) {
    hour = parseInt(tm[1], 10);
    minute = parseInt(tm[2], 10);
    timeStr = `${String(hour).padStart(2, '0')}.${String(minute).padStart(2, '0')}น.`;
  }

  if (day && month && year) {
    const pad = n => String(n).padStart(2, '0');
    const dateStr = `${pad(day)}/${pad(month)}/${year}`;
    const dateObj = new Date(year, month - 1, day, hour, minute);
    return {
      dateStr: dateStr,
      timeStr: timeStr,
      dateObj: dateObj,
      timestamp: dateObj.getTime()
    };
  }

  return { dateStr: '', timeStr: timeStr, dateObj: null, timestamp: 0 };
}

/**
 * สกัดข้อมูลตาราง parent จาก HTML ของ getTable.php
 */
function extractParentRowsMap(html) {
  const map = {};
  if (!html || typeof html !== 'string') return map;

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rHtml = rowMatch[1];
    const pMatch = rHtml.match(/ticket_view\.php\?id=(\d+)/i);
    if (!pMatch) continue;
    const parentId = pMatch[1];

    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let cm;
    while ((cm = cellRegex.exec(rHtml)) !== null) {
      cells.push(cm[1]);
    }

    // Col 0: Ticket No
    const col0Text = rocket.cleanText(cells[0] || '');
    const ticketNoMatch = col0Text.match(/([A-Z0-9-]+\.[A-Z0-9]+|[A-Z]{2,4}[0-9]{4}-[0-9]+)/i);
    const ticketNo = ticketNoMatch ? ticketNoMatch[1] : col0Text.split(/\s+/)[0];

    // Col 1: Creator (Salesperson) & Report Date
    const col1Lines = (cells[1] || '').split(/<br\s*\/?>/i).map(function(l) { return rocket.cleanText(l); }).filter(Boolean);
    const salesperson = col1Lines[0] || '';
    const reportDate = col1Lines[1] || '';

    // Col 2: Customer & Branch
    const col2Raw = cells[2] || '';
    let customer = '';
    let branch = '';
    const userLabelMatch = col2Raw.match(/<i[^>]*class=["'][^"']*fa-user[^"']*["'][^>]*><\/i>([\s\S]*?)<\/label>/i);
    if (userLabelMatch) {
      const parts = rocket.cleanText(userLabelMatch[1]).split(':');
      customer = rocket.cleanText(parts.length > 1 ? parts[parts.length - 1] : parts[0]);
    }
    const homeLabelMatch = col2Raw.match(/<i[^>]*class=["'][^"']*fa-home[^"']*["'][^>]*><\/i>([\s\S]*?)<\/label>/i);
    if (homeLabelMatch) {
      branch = rocket.cleanText(homeLabelMatch[1]);
      if (!branch.startsWith(':') && branch) {
        branch = ': ' + branch;
      }
    }

    // Col 3: Machine (Model & Brand)
    const col3Raw = cells[3] || '';
    let brand = '';
    let model = '';
    const brandMatch = col3Raw.match(/Brand\s*:\s*([^<\n]+)/i);
    if (brandMatch) {
      brand = rocket.cleanText(brandMatch[1]);
    }
    const modelMatch = col3Raw.match(/Model\s*:\s*([^<\n]+)/i);
    if (modelMatch) {
      model = rocket.cleanText(modelMatch[1]);
    }

    const prodMatch = col3Raw.match(/Modal_showPd\(['"](\d+)['"]\)/i);
    const productId = prodMatch ? prodMatch[1] : '';

    map[parentId] = {
      parentId: parentId,
      ticketNo: ticketNo,
      salesperson: salesperson,
      reportDate: reportDate,
      customer: customer,
      branch: branch,
      brand: brand,
      model: model,
      productId: productId
    };
  }

  return map;
}

/**
 * แปลงข้อมูลใบงานเป็นแถวข้อมูลตามลำดับ HEADERS
 */
function itemToRow(d, lastSync) {
  const brandVal = d.brand ? (d.brand.startsWith('Brand :') ? d.brand : 'Brand : ' + d.brand) : '';
  const modelVal = d.model ? (d.model.startsWith('Model :') ? d.model : 'Model : ' + d.model) : '';

  return [
    d.ticketNo || '',
    d.salesperson || '',
    d.reportDate || '',
    d.appointmentDate || '',
    d.appointmentTime || '',
    brandVal,
    modelVal,
    d.productDescription || '',
    d.customer || '',
    d.branch || '',
    d.location || '',
    d.type || '',
    d.note || '',
    d.url || '',
    lastSync
  ];
}

async function main() {
  console.log('========== 7-DAY INSTALLATION PLAN SYNC ==========');

  const auth = await rocket.rocketLogin();
  console.log('LOGIN OK');

  const range = compute7DayPlanRangeBangkok();
  console.log(`ช่วงวันที่นัดหมาย (วันนี้ + 7 วัน): ${range.start} ถึง ${range.end}`);

  // ==========================================
  // 1. ค้นหาตั๋วงานติดตั้ง (search_type=3, date_type=2)
  // ==========================================
  const parentHtml = await rocket.getParentTicketHtml(
    auth,
    range.start,
    range.end,
    DATE_TYPE_APPOINTMENT,
    '',
    SEARCH_TYPE_INSTALLATION
  );

  const parentMap = extractParentRowsMap(parentHtml);
  const parentIds = Object.keys(parentMap);
  console.log(`PARENT TICKETS งานติดตั้งที่พบ: ${parentIds.length}`);

  // ==========================================
  // 2. ค้นหา SUB TICKETS จาก checkrepair.php ของแต่ละ parent
  // ==========================================
  let candidateSubTickets = [];
  if (parentIds.length > 0) {
    const checkRepairResults = await rocket.mapConcurrent(parentIds, PARENT_CONCURRENCY, async function(parentId) {
      const html = await rocket.getCheckRepairHtml(parentId, auth);
      const ids = rocket.extractCheckRepairIds(html);
      return {
        parentId: parentId,
        ids: ids
      };
    });

    checkRepairResults.forEach(function(r) {
      if (r && !r.__error && r.ids && r.ids.length > 0) {
        r.ids.forEach(function(subId) {
          candidateSubTickets.push({
            subId: subId,
            parentId: r.parentId
          });
        });
      }
    });
  }

  console.log(`CANDIDATE SUB TICKETS ทั้งหมด: ${candidateSubTickets.length}`);

  // ==========================================
  // 3. ดึงรายละเอียด SUB TICKET และกรองเฉพาะวันนัดหมายที่ตรงกับช่วง 7 วัน
  // ==========================================
  let planItems = [];
  const processedParentIds = new Set();

  if (candidateSubTickets.length > 0) {
    const detailResults = await rocket.mapConcurrent(candidateSubTickets, SUB_CONCURRENCY, async function(c) {
      const html = await rocket.getTicketDetailHtml(c.subId, auth);
      const ticket = rocket.parseTicketDetail(html, c.subId);
      ticket.parentId = c.parentId;
      return ticket;
    });

    detailResults.forEach(function(r) {
      if (!r || r.__error) return;

      const parentMeta = parentMap[r.parentId] || {};
      const parsedAppt = parseAppointment(r.appointment);

      // ตรวจสอบว่าวันนัดหมายอยู่ในช่วง [วันนี้, วันนี้ + 7 วัน] หรือไม่
      let inRange = false;
      if (parsedAppt.dateObj) {
        inRange = parsedAppt.dateObj >= range.startDateObj && parsedAppt.dateObj <= range.endDateObj;
      }

      if (inRange) {
        processedParentIds.add(r.parentId);

        const note = r.causeFound || r.customerSymptom || r.repairNote || r.problem || r.note || r.workDescription || '';
        const location = r.machineLocation || parentMeta.location || '';
        const productDesc = r.productName || parentMeta.model || '';

        planItems.push({
          ticketNo: r.ticketNo || parentMeta.ticketNo || '',
          salesperson: parentMeta.salesperson || '',
          reportDate: r.reportDate || parentMeta.reportDate || '',
          appointmentDate: parsedAppt.dateStr,
          appointmentTime: parsedAppt.timeStr,
          timestamp: parsedAppt.timestamp,
          brand: parentMeta.brand || '',
          model: parentMeta.model || '',
          productDescription: productDesc,
          customer: r.customer || parentMeta.customer || '',
          branch: r.branch || parentMeta.branch || '',
          location: location,
          type: r.powerType || '',
          note: note,
          url: r.url || (parentMeta.parentId ? `https://rocket75.com/main/ticket_view.php?id=${parentMeta.parentId}` : '')
        });
      }
    });
  }

  // กรณี Parent ticket มีการนัดหมายแต่ยังไม่มี Sub ticket (หรือ Sub ticket ยังไม่มีรายละเอียด)
  parentIds.forEach(function(pId) {
    if (!processedParentIds.has(pId)) {
      const p = parentMap[pId];
      if (p) {
        planItems.push({
          ticketNo: p.ticketNo || '',
          salesperson: p.salesperson || '',
          reportDate: p.reportDate || '',
          appointmentDate: '',
          appointmentTime: '',
          timestamp: 0,
          brand: p.brand || '',
          model: p.model || '',
          productDescription: p.model || '',
          customer: p.customer || '',
          branch: p.branch || '',
          location: '',
          type: '',
          note: '',
          url: `https://rocket75.com/main/ticket_view.php?id=${pId}`
        });
      }
    }
  });

  // ==========================================
  // 4. เรียงลำดับตามวันนัดหมาย (เช้า -> เย็น) และตามเลขที่ใบงาน
  // ==========================================
  planItems.sort(function(a, b) {
    if (a.timestamp !== b.timestamp) {
      if (a.timestamp === 0) return 1;
      if (b.timestamp === 0) return -1;
      return a.timestamp - b.timestamp;
    }
    return (a.ticketNo || '').localeCompare(b.ticketNo || '');
  });

  console.log(`รายการติดตั้งทั้งหมดที่จะบันทึก: ${planItems.length}`);

  // ==========================================
  // 5. บันทึกลง Google Sheet '7-Day Installation Plan'
  // ==========================================
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new Error('ไม่พบ SPREADSHEET_ID ใน environment variables');
  }

  const sheets = await sheetsLib.getSheetsClient();
  const sheetId = await sheetsLib.ensureSheetExists(sheets, spreadsheetId, SHEET_NAME);

  const lastSync = rocket.formatLastSyncBangkok();
  const rows = planItems.map(function(item) {
    return itemToRow(item, lastSync);
  });

  await sheetsLib.replaceSheetData(sheets, spreadsheetId, sheetId, SHEET_NAME, HEADERS, rows);
  console.log(`เขียนลงชีท '${SHEET_NAME}' สำเร็จ: ${rows.length} แถว`);
  console.log('DONE');
}

main().catch(function(err) {
  console.error('7-Day Installation Plan sync failed:', err);
  process.exit(1);
});
