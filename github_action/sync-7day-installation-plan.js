/*************************************************
 * SYNC 7-DAY INSTALLATION PLAN
 *
 * รายงานแผนงานติดตั้ง 7 วัน เริ่มจากวันพรุ่งนี้
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
 * คำนวณช่วง 7 วัน เริ่มพรุ่งนี้ถึงวันที่ 7 นับจากวันนี้ (เวลาประเทศไทย UTC+7)
 */
function compute7DayPlanRangeBangkok(now = new Date()) {
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const bkkNow = new Date(utc + (7 * 3600000));

  const startDateObj = new Date(bkkNow);
  startDateObj.setDate(startDateObj.getDate() + 1);
  const startYear = startDateObj.getFullYear();
  const startMonth = startDateObj.getMonth() + 1;
  const startDay = startDateObj.getDate();

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
  const parts = rocket.parseDateParts(text);
  const { day = 0, month = 0, year = 0 } = parts || {};
  let hour = 0;
  let minute = 0;

  let timeStr = '';
  const tm = text.match(/(?:^|[T\s(])(\d{1,2})[:.](\d{2})(?::\d{2})?(?:\s*น\.?)?(?=\s|\)|$)/);
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
  console.log(`ช่วงวันที่นัดหมาย (เริ่มพรุ่งนี้ 7 วัน): ${range.start} ถึง ${range.end}`);

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
  const allParentIds = Object.keys(parentMap);
  console.log(`PARENT TICKETS งานติดตั้งที่พบทั้งหมด: ${allParentIds.length}`);

  // กรองเฉพาะตั๋วที่เป็น BKIN (Bangkok Installation) ตามเงื่อนไข
  const parentIds = allParentIds.filter(function(pId) {
    const tNo = (parentMap[pId] && parentMap[pId].ticketNo) || '';
    return /^BKIN/i.test(tNo.trim());
  });
  console.log(`PARENT TICKETS งานติดตั้งเฉพาะ BKIN: ${parentIds.length}`);

  // ==========================================
  // 2. ค้นหา SUB TICKETS จาก checkrepair.php ของแต่ละ parent
  //    และดึง OVERVIEW (ภาพรวม) เพื่อเอา "ที่อยู่สาขา" (Location)
  // ==========================================
  let candidateSubTickets = [];
  const overviewMap = {};

  if (parentIds.length > 0) {
    // 2.1 ดึง Sub tickets
    const checkRepairResults = await rocket.mapConcurrentStrict(parentIds, PARENT_CONCURRENCY, async function(parentId) {
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

    // 2.2 ดึง Overview ภาพรวมสำหรับ Location (ที่อยู่สาขา)
    console.log(`กำลังดึงข้อมูล Location (ที่อยู่สาขา) จากหน้าภาพรวม ticket_view (${parentIds.length} ใบงาน)...`);
    const overviewResults = await rocket.mapConcurrentStrict(parentIds, PARENT_CONCURRENCY, async function(parentId) {
      const html = await rocket.getOverviewHtml(parentId, auth);
      return {
        parentId: parentId,
        data: rocket.parseOverviewHtml(html)
      };
    });

    overviewResults.forEach(function(r) {
      if (r && !r.__error && r.data) {
        overviewMap[r.parentId] = r.data;
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
    const detailResults = await rocket.mapConcurrentStrict(candidateSubTickets, SUB_CONCURRENCY, async function(c) {
      const html = await rocket.getTicketDetailHtml(c.subId, auth);
      const ticket = rocket.parseTicketDetail(html, c.subId);
      if (!ticket.ticketNo && !ticket.status) {
        throw new Error('Invalid ticket detail for ' + c.subId);
      }
      ticket.parentId = c.parentId;
      return ticket;
    });

    detailResults.forEach(function(r) {
      if (!r || r.__error) return;

      const parentMeta = parentMap[r.parentId] || {};
      const ov = overviewMap[r.parentId] || {};
      const parsedAppt = parseAppointment(r.appointment);

      // ตรวจสอบว่าวันนัดหมายอยู่ในช่วง [พรุ่งนี้, วันที่ 7 นับจากวันนี้]
      let inRange = false;
      if (parsedAppt.dateObj) {
        inRange = parsedAppt.dateObj >= range.startDateObj && parsedAppt.dateObj <= range.endDateObj;
      }

      if (inRange) {
        processedParentIds.add(r.parentId);

        const note = r.causeFound || r.customerSymptom || r.repairNote || r.problem || r.note || r.workDescription || ov.problem || ov.note || '';
        const location = ov.branchAddress || r.machineLocation || parentMeta.location || '';
        const productDesc = r.productName || ov.productName || parentMeta.model || '';
        const type = r.powerType || ov.powerType || '';
        const customer = r.customer || ov.customer || parentMeta.customer || '';
        const branch = r.branch || ov.branch || parentMeta.branch || '';

        planItems.push({
          ticketNo: r.ticketNo || parentMeta.ticketNo || '',
          salesperson: parentMeta.salesperson || '',
          reportDate: r.reportDate || ov.reportDate || parentMeta.reportDate || '',
          appointmentDate: parsedAppt.dateStr,
          appointmentTime: parsedAppt.timeStr,
          timestamp: parsedAppt.timestamp,
          brand: parentMeta.brand || '',
          model: parentMeta.model || '',
          productDescription: productDesc,
          customer: customer,
          branch: branch,
          location: location,
          type: type,
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
      const ov = overviewMap[pId] || {};
      if (p) {
        planItems.push({
          ticketNo: p.ticketNo || '',
          salesperson: p.salesperson || '',
          reportDate: p.reportDate || ov.reportDate || '',
          appointmentDate: '',
          appointmentTime: '',
          timestamp: 0,
          brand: p.brand || '',
          model: p.model || '',
          productDescription: ov.productName || p.model || '',
          customer: ov.customer || p.customer || '',
          branch: ov.branch || p.branch || '',
          location: ov.branchAddress || '',
          type: ov.powerType || '',
          note: ov.problem || ov.note || '',
          url: `https://rocket75.com/main/ticket_view.php?id=${pId}`
        });
      }
    }
  });

  // กรองตั๋วที่ Ticket No ขึ้นต้นด้วย BKIN เท่านั้นตามเงื่อนไข
  planItems = planItems.filter(function(item) {
    return /^BKIN/i.test((item.ticketNo || '').trim());
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

  console.log(`รายการติดตั้ง (BKIN) ทั้งหมดที่จะบันทึก: ${planItems.length}`);
  planItems.forEach(p => {
    console.log(`- ${p.ticketNo}: นัด ${p.appointmentDate || '-'} ${p.appointmentTime || '-'} | Loc: ${p.location || '-'} | ${p.customer}`);
  });

  // ==========================================
  // 5. บันทึกลง Google Sheet '7-Day Installation Plan'
  // ==========================================
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new Error('ไม่พบ SPREADSHEET_ID ใน environment variables');
  }

  const sheets = await sheetsLib.getSheetsClient();
  const sheetId = await sheetsLib.ensureSheetExists(sheets, spreadsheetId, SHEET_NAME);

  const lastSync = rocket.formatDateTimeBangkok(new Date());
  const rows = planItems.map(function(item) {
    return itemToRow(item, lastSync);
  });

  const summaryText = `ช่วงข้อมูล ${range.start} - ${range.end} | จำนวน ${rows.length.toLocaleString('en-US')} รายการ`;
  await sheetsLib.replaceSheetDataWithSummary(sheets, spreadsheetId, sheetId, SHEET_NAME, summaryText, HEADERS, rows);
  console.log(`เขียนลงชีท '${SHEET_NAME}' สำเร็จ: ${rows.length} แถว (แถว 1: ${summaryText})`);
  console.log('DONE');
}

main().catch(function(err) {
  console.error('7-Day Installation Plan sync failed:', err);
  process.exit(1);
});
