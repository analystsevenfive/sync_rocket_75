/*************************************************
 * SHARED — login, HTTP helpers, HTML parsing สำหรับ
 * rocket75.com (Node.js port ของฟังก์ชันที่ใช้ร่วมกัน
 * ข้ามไฟล์ใน trick.js เดิม — rocketLogin_,
 * getParentTicketHtml_, extractParentTicketIds_,
 * buildCheckRepairRequest_, extractCheckRepairIds_,
 * buildTicketDetailRequest_, parseTicketDetail_,
 * cleanText_, getDtValue_, getH5Value_ ฯลฯ)
 *
 * ไม่ต้องมี resumable state (SYNC_PENDING_*) แบบ Apps
 * Script เพราะไม่มี cap 6 นาที/execution — ใช้
 * mapConcurrent() แทน fetchAllWithRetry_ + chunk loop
 *************************************************/

const ROCKET_BASE = 'https://rocket75.com';
const FETCH_TIMEOUT_MS = 30000;



function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}



// กัน connection ค้างตลอดกาล (ไม่เคย resolve/reject) จน
// กิน worker slot ของ mapConcurrent ไปทั้ง job — ไม่มี
// timeout เดิมเลยเพราะ fetch() เปล่าไม่มี timeout ในตัว
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(function() { controller.abort(); }, timeoutMs || FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}



async function rocketLogin() {

  const username = process.env.ROCKET_USERNAME;
  const password = process.env.ROCKET_PASSWORD;

  if (!username || !password) {
    throw new Error('ไม่พบ ROCKET_USERNAME / ROCKET_PASSWORD ใน environment variables');
  }

  const firstRes = await fetchWithTimeout(ROCKET_BASE + '/index.php', {
    method: 'GET',
    redirect: 'manual'
  });

  let cookie = '';
  const firstSetCookie = firstRes.headers.get('set-cookie');
  const firstMatch = firstSetCookie && firstSetCookie.match(/PHPSESSID=([^;]+)/i);
  if (firstMatch) {
    cookie = 'PHPSESSID=' + firstMatch[1];
  }

  const loginBody = new URLSearchParams();
  loginBody.set('username', username);
  loginBody.set('password', password);

  const loginHeaders = {
    Origin: ROCKET_BASE,
    Referer: ROCKET_BASE + '/index.php',
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest'
  };
  if (cookie) {
    loginHeaders.Cookie = cookie;
  }

  const loginRes = await fetchWithTimeout(ROCKET_BASE + '/auth.php', {
    method: 'POST',
    headers: loginHeaders,
    body: loginBody,
    redirect: 'manual'
  });

  const loginText = await loginRes.text();

  let data;
  try {
    data = JSON.parse(loginText);
  } catch (e) {
    throw new Error('auth.php ไม่คืน JSON: ' + loginText.substring(0, 300));
  }

  if (Number(data.sing) !== 1 || !data.token || !data.key) {
    throw new Error('Login ไม่สำเร็จ (sing=' + data.sing + ')');
  }

  const newSetCookie = loginRes.headers.get('set-cookie');
  const newMatch = newSetCookie && newSetCookie.match(/PHPSESSID=([^;]+)/i);
  if (newMatch) {
    cookie = 'PHPSESSID=' + newMatch[1];
  }

  return { cookie: cookie, token: data.token, key: data.key };

}



// เหมือน fetchAllWithRetry_ + chunk loop ใน trick.js
// แต่ไม่ต้องเก็บ pending state ข้าม execution เพราะรัน
// จบในโปรเซสเดียว — จำกัด concurrency ไม่ให้ยิงแรงเกิน
// ไปพร้อมกันทีเดียวหมด (เผื่อใจ rocket75.com เหมือนที่
// เคยคุยกันไว้)
// retries=1 (default) คือลองซ้ำ 1 ครั้งถ้าพลาด (รวม 2
// attempt) หน่วง 500ms ก่อน retry กันซ้ำเซิร์ฟเวอร์ที่กำลัง
// สะดุดอยู่ทันที — เทียบเท่า fetchAllWithRetry_ ฝั่ง Apps
// Script เดิมที่หายไปตอนพอร์ตมา Node (mapConcurrent เดิม
// ไม่มี retry เลย ทำให้ error ชั่วคราวกลายเป็น error ถาวร
// ของรอบนั้นทันที)
async function mapConcurrent(items, concurrency, worker, retries) {

  const maxRetries = retries === undefined ? 1 : retries;
  const results = new Array(items.length);
  let index = 0;

  async function runWithRetry(item, idx) {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await worker(item, idx);
      } catch (e) {
        lastErr = e;
        if (attempt < maxRetries) {
          await sleep(500 * (attempt + 1));
        }
      }
    }
    throw lastErr;
  }

  async function run() {
    while (index < items.length) {
      const current = index++;
      try {
        results[current] = await runWithRetry(items[current], current);
      } catch (e) {
        results[current] = { __error: e.message };
      }
    }
  }

  const poolSize = Math.min(concurrency, items.length);
  const workers = [];
  for (let i = 0; i < poolSize; i++) {
    workers.push(run());
  }
  await Promise.all(workers);

  return results;

}



function computeLast3MonthsRangeBangkok() {

  function bangkokDateParts(date) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const get = (t) => Number(parts.find(p => p.type === t).value);
    return { year: get('year'), month: get('month'), day: get('day') };
  }

  function fmt(year, month, day) {
    const dd = String(day).padStart(2, '0');
    const mm = String(month).padStart(2, '0');
    return dd + '/' + mm + '/' + year;
  }

  const now = bangkokDateParts(new Date());
  const end = fmt(now.year, now.month, now.day);

  // ใช้ Date object คำนวณ overflow เดือน/ปีให้อัตโนมัติ
  // (เช่นเดือน 1 - 3 เดือน = ปีก่อนหน้า เดือน 10-12)
  const threeMonthsAgo = new Date(now.year, now.month - 1 - 3, now.day);
  const start = fmt(
    threeMonthsAgo.getFullYear(),
    threeMonthsAgo.getMonth() + 1,
    threeMonthsAgo.getDate()
  );

  return { start: start, end: end };

}



// ใช้โดย sync-tomorrow-plan.js — start=end=วันพรุ่งนี้เสมอ
// (ตามเวลากรุงเทพ) คู่กับ date_type=2 (วันที่นัดหมาย)
function computeTomorrowRangeBangkok(date = new Date()) {

  function bangkokDateParts(d) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(d);
    const get = (t) => Number(parts.find(p => p.type === t).value);
    return { year: get('year'), month: get('month'), day: get('day') };
  }

  function fmt(year, month, day) {
    const dd = String(day).padStart(2, '0');
    const mm = String(month).padStart(2, '0');
    return dd + '/' + mm + '/' + year;
  }

  const now = bangkokDateParts(date);
  const tomorrow = new Date(now.year, now.month - 1, now.day + 1);
  const tomorrowParts = {
    year: tomorrow.getFullYear(),
    month: tomorrow.getMonth() + 1,
    day: tomorrow.getDate()
  };
  const tomorrowStr = fmt(tomorrowParts.year, tomorrowParts.month, tomorrowParts.day);

  return { start: tomorrowStr, end: tomorrowStr, dateParts: tomorrowParts };

}



// ใช้สำหรับ test หรือ sync แผนงานของวันนี้
function computeTodayRangeBangkok(date = new Date()) {

  function bangkokDateParts(d) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(d);
    const get = (t) => Number(parts.find(p => p.type === t).value);
    return { year: get('year'), month: get('month'), day: get('day') };
  }

  function fmt(year, month, day) {
    const dd = String(day).padStart(2, '0');
    const mm = String(month).padStart(2, '0');
    return dd + '/' + mm + '/' + year;
  }

  const now = bangkokDateParts(date);
  const todayParts = {
    year: now.year,
    month: now.month,
    day: now.day
  };
  const todayStr = fmt(todayParts.year, todayParts.month, todayParts.day);

  return { start: todayStr, end: todayStr, dateParts: todayParts };

}



// ใช้โดย sync-yesterday-jobs.js — start=end=เมื่อวานเสมอ (ตามเวลากรุงเทพ)
function computeYesterdayRangeBangkok(date = new Date()) {

  function bangkokDateParts(d) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(d);
    const get = (t) => Number(parts.find(p => p.type === t).value);
    return { year: get('year'), month: get('month'), day: get('day') };
  }

  function fmt(year, month, day) {
    const dd = String(day).padStart(2, '0');
    const mm = String(month).padStart(2, '0');
    return dd + '/' + mm + '/' + year;
  }

  const now = bangkokDateParts(date);
  const yesterday = new Date(now.year, now.month - 1, now.day - 1);
  const yesterdayParts = {
    year: yesterday.getFullYear(),
    month: yesterday.getMonth() + 1,
    day: yesterday.getDate()
  };
  const yesterdayStr = fmt(yesterdayParts.year, yesterdayParts.month, yesterdayParts.day);

  return { start: yesterdayStr, end: yesterdayStr, dateParts: yesterdayParts };

}



const MONTH_NAME_TO_NUMBER = {
  'jan': 1, 'january': 1, 'ม.ค.': 1, 'มค': 1, 'มกราคม': 1,
  'feb': 2, 'february': 2, 'ก.พ.': 2, 'กพ': 2, 'กุมภาพันธ์': 2,
  'mar': 3, 'march': 3, 'มี.ค.': 3, 'มีค': 3, 'มีนาคม': 3,
  'apr': 4, 'april': 4, 'เม.ย.': 4, 'เมย': 4, 'เมษายน': 4,
  'may': 5, 'พ.ค.': 5, 'พค': 5, 'พฤษภาคม': 5,
  'jun': 6, 'june': 6, 'มิ.ย.': 6, 'มิย': 6, 'มิถุนายน': 6,
  'jul': 7, 'july': 7, 'ก.ค.': 7, 'กค': 7, 'กรกฎาคม': 7,
  'aug': 8, 'august': 8, 'ส.ค.': 8, 'สค': 8, 'สิงหาคม': 8,
  'sep': 9, 'september': 9, 'sept': 9, 'ก.ย.': 9, 'กย': 9, 'กันยายน': 9,
  'oct': 10, 'october': 10, 'ต.ค.': 10, 'ตค': 10, 'ตุลาคม': 10,
  'nov': 11, 'november': 11, 'พ.ย.': 11, 'พย': 11, 'พฤศจิกายน': 11,
  'dec': 12, 'december': 12, 'ธ.ค.': 12, 'ธค': 12, 'ธันวาคม': 12
};



function parseDateParts(dateStr) {

  if (!dateStr || typeof dateStr !== 'string') {
    return null;
  }
  const cleaned = dateStr.trim();

  // 1. "04 Sep 2026 08:00", "24 Aug 2026 16:03", "4 ก.ย. 2569", "4 กันยายน 2026"
  const textMonthMatch = cleaned.match(/(\d{1,2})\s+([A-Za-zก-๙.]+)\s+(\d{4})/i);
  if (textMonthMatch) {
    const day = parseInt(textMonthMatch[1], 10);
    const monthRaw = textMonthMatch[2].toLowerCase().trim();
    const monthKey = monthRaw.replace(/\./g, '');
    const month = MONTH_NAME_TO_NUMBER[monthKey] || MONTH_NAME_TO_NUMBER[monthRaw];
    let year = parseInt(textMonthMatch[3], 10);
    if (year > 2400) {
      year -= 543;
    }
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && year > 2000) {
      return { year, month, day };
    }
  }

  // 2. "04/09/2026", "4-9-2026" (DD/MM/YYYY or DD-MM-YYYY)
  const dmyMatch = cleaned.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dmyMatch) {
    const day = parseInt(dmyMatch[1], 10);
    const month = parseInt(dmyMatch[2], 10);
    let year = parseInt(dmyMatch[3], 10);
    if (year > 2400) {
      year -= 543;
    }
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && year > 2000) {
      return { year, month, day };
    }
  }

  // 3. "2026-09-04", "2026/09/04" (YYYY-MM-DD or YYYY/MM/DD)
  const ymdMatch = cleaned.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (ymdMatch) {
    let year = parseInt(ymdMatch[1], 10);
    const month = parseInt(ymdMatch[2], 10);
    const day = parseInt(ymdMatch[3], 10);
    if (year > 2400) {
      year -= 543;
    }
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && year > 2000) {
      return { year, month, day };
    }
  }

  return null;

}



function isMatchingDateParts(dateStr, targetParts) {

  const parsed = parseDateParts(dateStr);
  if (!parsed || !targetParts) {
    return false;
  }
  return parsed.year === targetParts.year &&
         parsed.month === targetParts.month &&
         parsed.day === targetParts.day;

}



// แปลง appointment string เช่น "04 Sep 2026 08:00" เป็น timestamp เพื่อใช้จัดเรียงตามเวลาจากเช้าไปเย็น
function parseAppointmentTimestamp(appointmentStr) {

  if (!appointmentStr || typeof appointmentStr !== 'string') {
    return Infinity;
  }

  const parts = parseDateParts(appointmentStr);
  const timeMatch = appointmentStr.match(/(\d{1,2}):(\d{2})/);
  const hours = timeMatch ? parseInt(timeMatch[1], 10) : 0;
  const minutes = timeMatch ? parseInt(timeMatch[2], 10) : 0;

  if (parts) {
    return new Date(parts.year, parts.month - 1, parts.day, hours, minutes).getTime();
  }

  return Infinity;

}



function formatDateTimeBangkok(date) {

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(date);

  const get = (t) => parts.find(p => p.type === t).value;

  return get('day') + '/' + get('month') + '/' + get('year') + ' ' +
    get('hour') + ':' + get('minute') + ':' + get('second');

}



// แปลงวันเวลา เช่น "18/08/2026 11:21" หรือ "04 Sep 2026 16:03" เป็น timestamp (ms)
function parseDateTimeBangkok(str) {

  if (!str || typeof str !== 'string') {
    return null;
  }
  const cleaned = str.trim();
  if (!cleaned || cleaned.includes('ยังไม่มีข้อมูล')) {
    return null;
  }

  const timeMatch = cleaned.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  const hours = timeMatch ? parseInt(timeMatch[1], 10) : 0;
  const minutes = timeMatch ? parseInt(timeMatch[2], 10) : 0;
  const seconds = timeMatch && timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;

  const dateParts = parseDateParts(cleaned);
  if (!dateParts) {
    return null;
  }

  return new Date(dateParts.year, dateParts.month - 1, dateParts.day, hours, minutes, seconds).getTime();

}



// คำนวณระยะเวลาจาก reportDate ถึง endTime คืนค่าเป็น "ชั่วโมง.นาที" เช่น "61.45"
function computeWorkingTime(reportDateStr, endTimeStr) {

  const startMs = parseDateTimeBangkok(reportDateStr);
  const endMs = parseDateTimeBangkok(endTimeStr);
  if (!startMs || !endMs) {
    return '';
  }

  const diffMs = endMs - startMs;
  if (diffMs < 0) {
    return '';
  }

  const totalMinutes = Math.floor(diffMs / (60 * 1000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return hours + '.' + String(minutes).padStart(2, '0');

}




/*************************************************
 * PARENT TICKETS (getTable.php)
 *************************************************/

// dateType: '1' = ค้นหาจากวันที่แจ้ง/สร้างตั๋ว (default,
// ใช้โดย sync-tickets.js/trick2/stage), '2' = ค้นหาจาก
// "วันที่นัดหมาย" (ยืนยันจริงจาก DevTools ตอนเลือก dropdown
// "ค้นหาจากวัน" บนหน้า ticket_list.php) — คนละ field วันที่
// กันเลย ใช้โดย sync-tomorrow-plan.js
async function getParentTicketHtml(auth, startDate, endDate, dateType, nameSearch) {

  const headers = {
    Origin: ROCKET_BASE,
    Referer: ROCKET_BASE + '/main/ticket_list.php',
    'X-Requested-With': 'XMLHttpRequest'
  };
  if (auth.cookie) {
    headers.Cookie = auth.cookie;
  }

  const body = new URLSearchParams();
  body.set('status', '');
  body.set('start_date', startDate || '');
  body.set('end_date', endDate || '');
  body.set('search_checkrepair', 'x');
  body.set('name_search', nameSearch || '');
  body.set('search_team', 'x');
  body.set('search_staff', 'x');
  body.set('token', auth.token);
  body.set('key', auth.key);
  body.set('search_type', 'x');
  body.set('search_area', 'x');
  body.set('date_type', dateType || '1');
  body.set('search_warranty_type', 'x');

  // ตารางนี้คืน parent ticket ทั้งหมดในช่วงวันที่เดียว
  // (~2,150+ รายการสำหรับ 3 เดือน) หนักกว่าการ fetch ทีละ
  // ใบมาก — 30 วิ default ไม่พอจริง (เจอ AbortError จริง)
  // ให้เวลามากกว่าปกติเฉพาะจุดนี้
  const res = await fetchWithTimeout(ROCKET_BASE + '/main/ajax/ticket/getTable.php', {
    method: 'POST',
    headers: headers,
    body: body
  }, 120000);

  if (res.status !== 200) {
    throw new Error('getTable.php HTTP ' + res.status);
  }

  return res.text();

}



function extractParentTicketIds(html) {

  const ids = [];
  const regex = /ticket_view\.php\?id=(\d+)/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    ids.push(m[1]);
  }
  return [...new Set(ids)];

}



function extractParentToProductIdMap(html) {

  const map = {};
  if (!html || typeof html !== 'string') {
    return map;
  }

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const content = match[1];
    const parentMatch = content.match(/ticket_view\.php\?id=(\d+)/i);
    const prodMatch = content.match(/Modal_showPd\(['"](\d+)['"]\)/i);
    if (parentMatch && prodMatch) {
      map[parentMatch[1]] = prodMatch[1];
    }
  }

  return map;

}




/*************************************************
 * SUB TICKETS (checkrepair.php)
 *************************************************/

async function getCheckRepairHtml(parentId, auth) {

  const headers = {
    Origin: ROCKET_BASE,
    Referer: ROCKET_BASE + '/main/ticket_view.php?id=' + parentId,
    'X-Requested-With': 'XMLHttpRequest'
  };
  if (auth.cookie) {
    headers.Cookie = auth.cookie;
  }

  const body = new URLSearchParams();
  body.set('ticket_id', String(parentId));
  body.set('token', auth.token);
  body.set('key', auth.key);

  const res = await fetchWithTimeout(ROCKET_BASE + '/main/ajax/ticket_view/checkrepair.php', {
    method: 'POST',
    headers: headers,
    body: body
  });

  if (res.status !== 200) {
    throw new Error('checkrepair.php HTTP ' + res.status);
  }

  return res.text();

}



function extractCheckRepairIds(html) {

  const ids = [];
  const regex = /ticket_checkrepair_view\.php\?id=(\d+)/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    ids.push(m[1]);
  }
  return [...new Set(ids)];

}



// ใช้โดย syncTrick2 เพื่อดึงชื่อทีม/ช่างจากตาราง
// "ตรวจเช็ค/เข้าซ่อม" ของหน้า parent (extractCheckRepairInfo_)
function extractCheckRepairInfo(html) {

  const info = {};
  const rowRegex = /<tr\s+id=["']tr_(\d+)["'][^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {

    const subId = rowMatch[1];
    const rowHtml = rowMatch[2];

    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      cells.push(cellMatch[1]);
    }

    const appointmentCell = cells[1] || '';
    const technicianCell = cells[2] || '';

    let team = '';
    const teamMatch = appointmentCell.match(/ทีม\s*:\s*([^<\n]+)/i) ||
                      appointmentCell.match(/ทีม\s*:\s*([\s\S]*?)<br/i) ||
                      technicianCell.match(/ทีม\s*([A-Za-z0-9\s()]+)/i);
    if (teamMatch) {
      team = cleanText(teamMatch[1]);
    }

    const technicians = technicianCell
      .split(/<br\s*\/?>/i)
      .map(function(line) {
        const cleaned = cleanText(line);
        const idx = cleaned.indexOf('ทีม');
        return idx >= 0 ? cleaned.substring(0, idx).trim() : cleaned;
      })
      .filter(function(name) { return name !== ''; });

    const ticketNoMatch = cells[0] ? cells[0].match(/([A-Z0-9-]+\.[A-Z0-9]+)/i) : null;
    const ticketNo = ticketNoMatch ? cleanText(ticketNoMatch[1]) : '';

    const subInfo = {
      subId: subId,
      ticketNo: ticketNo,
      team: team,
      technicians: technicians.join(', ')
    };

    info[subId] = subInfo;
    if (ticketNo) {
      info[ticketNo] = subInfo;
    }

  }

  return info;

}



/*************************************************
 * SUB TICKET DETAIL (ticket_checkrepair_view.php)
 *************************************************/

async function getTicketDetailHtml(ticketId, auth) {

  const headers = { Referer: ROCKET_BASE + '/main/' };
  if (auth.cookie) {
    headers.Cookie = auth.cookie;
  }

  const res = await fetchWithTimeout(
    ROCKET_BASE + '/main/ticket_checkrepair_view.php?id=' + ticketId,
    { method: 'GET', headers: headers, redirect: 'follow' }
  );

  if (res.status !== 200) {
    throw new Error('Ticket Detail HTTP ' + res.status);
  }

  return res.text();

}



function parseTicketDetail(html, ticketId) {

  // เดิมเดารูปแบบเลขตั๋วด้วย regex (hardcode ต่อท้าย ".R<เลข>"
  // ก่อน แล้วขยายเป็นตัวอักษรใดก็ได้ทีหลัง) แต่ตรวจ HTML จริง
  // แล้วพบว่าเลขตั๋วเต็มๆ อยู่ใน breadcrumb เป็นรายการสุดท้าย
  // (หน้าหลัก / รายการ Ticket / <parent> / <เลขตั๋วนี้>) แบบ
  // plain text ไม่มี suffix ให้เดาเลย — ดึงจากตำแหน่งนี้ตรงๆ
  // แทน ทนทานกว่าและไม่เสี่ยงไปจับข้อความอื่นในหน้าที่หน้าตา
  // คล้ายกันโดยบังเอิญ (แบบที่ fallback regex เดิมเสี่ยงอยู่)
  const ticketNo = extractLastBreadcrumbText(html) ||
    extractRegex(html, /([A-Z]+[A-Z0-9-]+\.[A-Z]+\d+)/i);

  const parentId = extractRegex(html, /ticket_view\.php\?id=(\d+)/i);

  const parentTicketNo = cleanText(
    extractRegex(html, /<a\s+href=["']ticket_view\.php\?id=\d+["'][^>]*>([\s\S]*?)<\/a>/i)
  ).replace(/^\/\s*/, '');

  const appointment = extractBeforeLabel(html, 'เวลานัดหมาย');

  const status = extractRegex(
    html,
    /d-flex align-items-center mb-1[\s\S]*?<span[^>]*class=["'][^"']*badge[^"']*["'][^>]*>([\s\S]*?)<\/span>/i
  );

  return {
    ticketId: ticketId,
    parentTicketId: parentId,
    parentTicketNo: parentTicketNo,
    ticketNo: cleanText(ticketNo),
    status: cleanText(status),
    appointment: cleanText(appointment),

    reportDate: getDtValue(html, 'วันที่แจ้ง'),
    customer: getDtValue(html, 'ลูกค้า'),
    branch: getDtValue(html, 'สาขา'),
    contact: getDtValue(html, 'ผู้ติดต่อ'),
    phone: getDtValue(html, 'เบอร์โทร'),
    problem: getDtValue(html, 'อาการเสีย'),
    workDescription: getDtValue(html, 'คำอธิบายงาน'),
    specialCondition: getDtValue(html, 'เงื่อนไข/อุปกรณ์พิเศษ'),
    note: getDtValue(html, 'หมายเหตุ'),
    machineLocation: getDtValue(html, 'ที่อยู่ปัจจุบันของเครื่อง'),

    productCode: getDtValue(html, 'รหัสรุ่น'),
    productName: getDtValue(html, 'ชื่อรุ่น'),
    powerType: getDtValue(html, 'ประเภท'),
    serial: getDtValue(html, 'Serial'),
    warranty: getDtValue(html, 'ประกัน'),

    startTime: getH5Value(html, 'เวลาเข้างาน'),
    endTime: getH5Value(html, 'เวลาเสร็จงาน'),
    duration: getH5Value(html, 'เวลาที่ใช้ (นาที)'),
    timeRecorder: getH5Value(html, 'ผู้บันทึกเวลา'),

    repairResult: getH5Value(html, 'ผลการซ่อม'),
    customerSymptom: getH5Value(html, 'อาการเสียจากลูกค้า'),
    causeFound: getH5Value(html, 'หมายเหตุที่พบ'),
    solution: getH5Value(html, 'การแก้ไข'),
    repairNote: getH5Value(html, 'บันทึกการซ่อม'),
    partFailureCause: getH5Value(html, 'สาเหตุการชำรุดของอะไหล่'),
    technician: getH5Value(html, 'ช่างเทคนิค') || extractRelatedPerson(html),

    url: ROCKET_BASE + '/main/ticket_checkrepair_view.php?id=' + ticketId
  };

}



/*************************************************
 * PARENT PAGE (ticket_view.php) — ใช้โดย Ticket Stage
 *************************************************/

async function getParentPageHtml(parentId, auth) {

  const headers = {};
  if (auth.cookie) {
    headers.Cookie = auth.cookie;
  }

  const res = await fetchWithTimeout(ROCKET_BASE + '/main/ticket_view.php?id=' + parentId, {
    method: 'GET',
    headers: headers
  });

  if (res.status !== 200) {
    throw new Error('ticket_view.php HTTP ' + res.status);
  }

  return res.text();

}



/*************************************************
 * INSPECTOR MODAL (ModalView_inspector.php)
 *************************************************/

async function getInspectorModalHtml(ticketId, auth) {

  const headers = {
    Origin: ROCKET_BASE,
    Referer: ROCKET_BASE + '/main/ticket_checkrepair_view.php?id=' + ticketId,
    'X-Requested-With': 'XMLHttpRequest'
  };
  if (auth.cookie) {
    headers.Cookie = auth.cookie;
  }

  const body = new URLSearchParams();
  body.set('ticket_checkrepair_id', String(ticketId));
  body.set('id', String(ticketId));
  body.set('ticket_id', String(ticketId));
  body.set('token', auth.token);
  body.set('key', auth.key);

  try {
    const res = await fetchWithTimeout(
      ROCKET_BASE + '/main/ajax/ticket_view/inspector/ModalView_inspector.php',
      { method: 'POST', headers: headers, body: body }
    );
    if (res.status === 200) {
      return await res.text();
    }
  } catch (e) {
    // ignore
  }

  return '';

}



function parseInspectorModal(html) {

  if (!html) {
    return { status: '', type: '', inspector: '', note: '' };
  }

  // 1. คัดเฉพาะแท็บ "ตรวจงาน" (id="inspector_tab_pane_1") เพื่อไม่ให้ปนกับแท็บอื่น
  let tabHtml = html;
  const tabMatch = html.match(/id=["']inspector_tab_pane_1["'][\s\S]*?(?=<div[^>]*id=["']inspector_tab_pane_2["']|<\/form>|$)/i);
  if (tabMatch) {
    tabHtml = tabMatch[0];
  }

  let status = '';
  let type = '';
  let inspector = '';
  let note = '';

  // 2. ดึง status จาก label ที่ระบุ class text-... (เช่น text-success "งานจบ", text-danger "งานไม่จบ")
  const statusLabelMatch = tabHtml.match(/<label[^>]*class=["'][^"']*text-(?:danger|success|primary|warning|info|secondary)[^"']*["'][^>]*>([\s\S]*?)<\/label>/i);
  if (statusLabelMatch) {
    status = cleanText(statusLabelMatch[1]);
  }

  // 3. หาทั้งแถวที่เป็นค่า (โครงสร้างเป็น <div class="row mb-3"> 2 แถว แถวแรกคือ header แถวที่สองคือ value)
  const rowMatches = tabHtml.match(/<div\s+class=["']row\s+mb-3["'][^>]*>[\s\S]*?<\/div>\s*<\/div>/gi) || [];
  if (rowMatches.length >= 2) {
    const valRow = rowMatches[1];
    const cols = [];
    const colRegex = /<div\s+class=["']col-(?:3|4)\s+mb-3["'][^>]*>([\s\S]*?)<\/div>/gi;
    let cm;
    while ((cm = colRegex.exec(valRow)) !== null) {
      cols.push(cleanText(cm[1]));
    }
    if (!status && cols.length >= 1) status = cols[0];
    if (cols.length >= 2 && cols[1] !== 'ไม่ระบุ') type = cols[1];
    if (cols.length >= 3) inspector = cols[2];
  }

  // 4. Fallback ป้องกันกรณี status ติดชื่อ header (เช่น "ประเภท", "สถานะ")
  const invalidStatuses = ['สถานะ', 'ประเภท', 'ผู้ตรวจ', 'หมายเหตุ'];
  if (!status || invalidStatuses.includes(status)) {
    if (tabHtml.includes('งานไม่จบ')) {
      status = 'งานไม่จบ';
    } else if (tabHtml.includes('งานจบ')) {
      status = 'งานจบ';
    } else if (tabHtml.includes('รอตรวจงาน')) {
      status = 'รอตรวจงาน';
    } else {
      status = '';
    }
  }

  // 5. หมายเหตุ (textarea id="inspector_note")
  const noteMatch = tabHtml.match(/<textarea[^>]*id=["']inspector_note["'][^>]*>([\s\S]*?)<\/textarea>/i);
  if (noteMatch) {
    note = cleanText(noteMatch[1]);
  }

  return {
    status: status,
    type: type,
    inspector: inspector,
    note: note
  };

}



/*************************************************
 * PRODUCT MODAL (ModalProduct.php)
 *************************************************/

async function getModalProductHtml(productId, auth) {

  const headers = {
    Origin: ROCKET_BASE,
    Referer: ROCKET_BASE + '/main/ticket_list.php',
    'X-Requested-With': 'XMLHttpRequest'
  };
  if (auth.cookie) {
    headers.Cookie = auth.cookie;
  }

  const body = new URLSearchParams();
  body.set('product_id', String(productId));
  body.set('token', auth.token);
  body.set('key', auth.key);

  try {
    const res = await fetchWithTimeout(
      ROCKET_BASE + '/main/ajax/ticket/ModalProduct.php',
      { method: 'POST', headers: headers, body: body }
    );
    if (res.status === 200) {
      return await res.text();
    }
  } catch (e) {
    // ignore
  }

  return '';

}



function parseSalesInvoiceNo(html) {

  if (!html || typeof html !== 'string') {
    return '';
  }

  const labelMatch = html.match(/<label[^>]*>\s*เลขที่บิลขาย\s*<\/label>[\s\S]*?<input\b([^>]*)>/i);
  if (labelMatch) {
    const valMatch = labelMatch[1].match(/\bvalue=["']([^"']*)["']/i);
    return valMatch ? cleanText(valMatch[1]) : '';
  }

  return '';

}



/*************************************************
 * HTML HELPERS (port ตรงจาก trick.js — logic เดิมเป๊ะ)
 *************************************************/


function decodeXmlEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}



function cleanText(html) {

  if (html === null || html === undefined) {
    return '';
  }

  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();

}



function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}



function getDtValue(html, label) {

  const escaped = escapeRegex(label);
  const regex = new RegExp(
    '<dt[^>]*>\\s*' + escaped + '\\s*:?\\s*<\\/dt>[\\s\\S]*?<dd[^>]*>([\\s\\S]*?)<\\/dd>',
    'i'
  );
  const m = html.match(regex);
  return m ? cleanText(m[1]) : '';

}



function getH5Value(html, label) {

  const escaped = escapeRegex(label);
  const regex = new RegExp(
    '<h5[^>]*>\\s*' + escaped + '\\s*<\\/h5>[\\s\\S]*?<(?:label|div)[^>]*>([\\s\\S]*?)<\\/(?:label|div)>',
    'i'
  );
  const m = html.match(regex);
  return m ? cleanText(m[1]) : '';

}



function extractBeforeLabel(html, label) {

  const escaped = escapeRegex(label);
  const regex = new RegExp(
    '<div[^>]*class=["\'][^"\']*fs-4[^"\']*["\'][^>]*>([\\s\\S]*?)<\\/div>[\\s\\S]*?' + escaped,
    'i'
  );
  const m = html.match(regex);
  return m ? cleanText(m[1]) : '';

}



// breadcrumb ของหน้า detail: หน้าหลัก / รายการ Ticket /
// <parent> / <ticket นี้> — รายการสุดท้ายคือเลขตั๋วเต็มๆ
// เป็น plain text (ไม่มี <a> ล้อมเหมือนรายการก่อนหน้า)
// ไม่ต้องเดารูปแบบ suffix เลย ต่างจาก parentTicketNo ที่ดึง
// จาก <a href="ticket_view.php?..."> ได้ตรงๆ อยู่แล้ว
function extractLastBreadcrumbText(html) {

  const regex = /<li[^>]*class=["'][^"']*breadcrumb-item[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  let match;
  let last = null;

  while ((match = regex.exec(html)) !== null) {
    last = match[1];
  }

  if (last === null) {
    return '';
  }

  return cleanText(last).replace(/^\/\s*/, '');

}



function extractRegex(text, regex) {
  const m = text.match(regex);
  if (!m) {
    return '';
  }
  return m[1] || '';
}



// ดึงชื่อช่าง/ผู้รับผิดชอบจากบล็อก "ผู้เกี่ยวข้อง" ในหน้า ticket_checkrepair_view.php
function extractRelatedPerson(html) {

  if (!html || typeof html !== 'string') {
    return '';
  }

  const idx = html.indexOf('ผู้เกี่ยวข้อง');
  if (idx === -1) {
    return '';
  }

  const chunk = html.substring(idx, idx + 1000);
  const textMatches = chunk.match(/<(?:div|span|a|p|label)[^>]*>([\s\S]*?)<\/(?:div|span|a|p|label)>/gi) || [];

  for (const item of textMatches) {
    const cleaned = cleanText(item);
    if (cleaned && cleaned !== 'ผู้เกี่ยวข้อง' && !cleaned.includes('http') && cleaned.length > 1 && cleaned.length < 50) {
      return cleaned;
    }
  }

  return '';

}



module.exports = {
  ROCKET_BASE,
  rocketLogin,
  fetchWithTimeout,
  mapConcurrent,
  computeLast3MonthsRangeBangkok,
  computeTomorrowRangeBangkok,
  computeTodayRangeBangkok,
  computeYesterdayRangeBangkok,
  parseDateParts,
  isMatchingDateParts,
  parseAppointmentTimestamp,
  formatDateTimeBangkok,
  parseDateTimeBangkok,
  computeWorkingTime,
  getParentTicketHtml,
  extractParentTicketIds,
  extractParentToProductIdMap,
  getCheckRepairHtml,
  extractCheckRepairIds,
  extractCheckRepairInfo,
  getTicketDetailHtml,
  parseTicketDetail,
  getParentPageHtml,
  getInspectorModalHtml,
  parseInspectorModal,
  getModalProductHtml,
  parseSalesInvoiceNo,
  decodeXmlEntities,
  cleanText,
  escapeRegex,
  getDtValue,
  getH5Value,
  extractBeforeLabel,
  extractRelatedPerson,
  extractLastBreadcrumbText,
  extractRegex
};

