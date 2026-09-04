/*************************************************
 * SYNC EMPLOYEE ORGANIZATION CHART
 *
 * ดึงข้อมูลผังองค์กรพนักงานจาก https://rocket75.com/hr/organization_chart.php
 * คอลัมน์ (Header ภาษาอังกฤษ):
 *   Position, Level, Employee ID, Full Name, Nickname, Desk, Last Sync
 * เขียนลงชีท: Employee
 *************************************************/

const rocket = require('./lib/rocket-client');
const sheetsLib = require('./lib/sheets-client');

const ROCKET_BASE = 'https://rocket75.com';
const EMPLOYEE_SHEET_NAME = 'Employee';

const EMPLOYEE_HEADERS = [
  'Position',
  'Level',
  'Employee ID',
  'Full Name',
  'Nickname',
  'Desk',
  'Last Sync'
];

/**
 * ทำความสะอาดข้อความและตัดช่องว่าง
 */
function cleanText(html) {
  return rocket.cleanText(html);
}

/**
 * แกะข้อมูลพนักงานจากชุดข้อความหรือ HTML บล็อกของการ์ดผังองค์กร
 */
function parseEmployeeLines(lines) {
  let position = '';
  let level = '';
  let employeeId = '';
  let fullName = '';
  let nickname = '';
  let desk = '';

  for (const line of lines) {
    if (!line) continue;

    // 1. รหัสพนักงาน: ตัวเลข 6-8 หลัก (เช่น 0115001, 0426018, 0419013)
    if (!employeeId && /^\d{6,8}$/.test(line)) {
      employeeId = line;
      continue;
    }

    // 2. โต๊ะ: เช่น "โต๊ะ: -", "โต๊ะ: 205", "โต๊ะ: 202"
    if (/^โต๊ะ\s*:/i.test(line)) {
      const match = line.match(/^โต๊ะ\s*:\s*(.*)/i);
      desk = match ? match[1].trim() : '';
      continue;
    }

    // 3. ตำแหน่งและ Level: เช่น "ผู้จัดการแผนกธุรการช่าง (L.8)", "หัวหน้าธุรการช่าง (L.5)"
    const levelMatch = line.match(/^(.*?)\s*\(\s*(L\.?\s*\d+(?:\.\d+)?)\s*\)$/i);
    if (levelMatch) {
      position = levelMatch[1].trim();
      level = levelMatch[2].replace(/\s+/g, '').toUpperCase();
      continue;
    }

    // 4. ชื่อ-นามสกุล และชื่อเล่น: เช่น "ข้องนาง โพธิ์ศรี (นุ่น)", "กมลชนก พันธุ์ฤทธิ์ (-)"
    const nameMatch = line.match(/^([ก-๙a-zA-Z\s.]+)\s*\(\s*(.*?)\s*\)$/);
    if (nameMatch) {
      fullName = nameMatch[1].trim();
      nickname = nameMatch[2].trim();
      continue;
    }

    // 5. กรณีไม่มีวงเล็บ Level หรือ Nickname
    if (!position && (
      line.includes('ผู้จัดการ') ||
      line.includes('หัวหน้า') ||
      line.includes('เจ้าหน้าที่') ||
      line.includes('ช่าง') ||
      line.includes('ผู้อำนวยการ') ||
      line.includes('กรรมการ') ||
      line.includes('พนักงาน') ||
      line.includes('ประสานงาน')
    )) {
      position = line;
    } else if (!fullName && /^[ก-๙a-zA-Z\s.]+$/.test(line) && line.includes(' ')) {
      fullName = line;
    }
  }

  if (employeeId || (fullName && position)) {
    return {
      position: position || '',
      level: level || '',
      employeeId: employeeId || '',
      fullName: fullName || '',
      nickname: nickname || '',
      desk: desk || ''
    };
  }

  return null;
}

/**
 * ดึงรายการพนักงานทั้งหมดจาก HTML (ทั้งแบบบล็อก card/node และ regex scan ทั้งหน้า)
 */
function extractEmployeesFromHtml(html) {
  const employees = [];
  const seenIds = new Set();

  if (!html || typeof html !== 'string') {
    return employees;
  }

  // 1. สแกนหา node / card elements ใน DOM
  const blockRegex = /<(?:div|td|li|tr|table)[^>]*class=["'][^"']*(?:node|card|user|employee|person|box|org|item)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|td|li|tr|table)>/gi;
  let blockMatch;
  while ((blockMatch = blockRegex.exec(html)) !== null) {
    const text = cleanText(blockMatch[1]);
    const lines = text.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
    const emp = parseEmployeeLines(lines);
    if (emp && emp.employeeId && !seenIds.has(emp.employeeId)) {
      seenIds.add(emp.employeeId);
      employees.push(emp);
    }
  }

  // 2. Fallback scanning: สแกนรอบตำแหน่งของรหัสพนักงาน (6-8 หลัก) ในข้อความทั้งหน้า
  const fullText = cleanText(html);
  const fullLines = fullText.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });

  for (let i = 0; i < fullLines.length; i++) {
    if (/^\d{6,8}$/.test(fullLines[i])) {
      const id = fullLines[i];
      if (seenIds.has(id)) continue;

      // ดูบรรทัดรอบๆ ID (ก่อนหน้า 2 บรรทัด, ถัดไป 2 บรรทัด)
      const windowLines = fullLines.slice(Math.max(0, i - 2), Math.min(fullLines.length, i + 3));
      const emp = parseEmployeeLines(windowLines);
      if (emp && emp.employeeId && !seenIds.has(emp.employeeId)) {
        seenIds.add(emp.employeeId);
        employees.push(emp);
      }
    }
  }

  return employees;
}

/**
 * ดึงหน้าหลัก /hr/organization_chart.php
 */
async function fetchOrgChartPage(auth) {
  const headers = {
    Referer: ROCKET_BASE + '/main/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
  };
  if (auth.cookie) {
    headers.Cookie = auth.cookie;
  }

  const res = await fetch(ROCKET_BASE + '/hr/organization_chart.php', {
    method: 'GET',
    headers: headers
  });

  if (res.status !== 200) {
    throw new Error('organization_chart.php HTTP ' + res.status);
  }

  return res.text();
}

/**
 * ดึงข้อมูลจาก AJAX Table.php (ถ้ามี)
 */
async function fetchOrgChartTableAjax(auth, departmentId) {
  const headers = {
    Origin: ROCKET_BASE,
    Referer: ROCKET_BASE + '/hr/organization_chart.php',
    'X-Requested-With': 'XMLHttpRequest'
  };
  if (auth.cookie) {
    headers.Cookie = auth.cookie;
  }

  const body = new URLSearchParams();
  body.set('token', auth.token);
  body.set('key', auth.key);
  if (departmentId !== undefined && departmentId !== '') {
    body.set('department_id', String(departmentId));
    body.set('hr_department_id', String(departmentId));
  }

  try {
    const res = await fetch(ROCKET_BASE + '/hr/ajax/organization_chart/Table.php', {
      method: 'POST',
      headers: headers,
      body: body
    });
    if (res.status === 200) {
      return await res.text();
    }
  } catch (e) {
    // AJAX Table.php อาจไม่มีหรือ error ปล่อยผ่านไป
  }

  return '';
}

/**
 * ดึงรายการแผนกเพื่อดึงข้อมูลให้ครบทุกแผนก
 */
async function fetchDepartmentIds(auth, html) {
  const deptIds = new Set();

  // ดึงจาก <select> ใน HTML
  const selectRegex = /<select[^>]*name=["'](?:department_id|hr_department_id|search_department)["'][^>]*>([\s\S]*?)<\/select>/gi;
  const match = selectRegex.exec(html);
  if (match) {
    const optionRegex = /<option[^>]*value=["']([^"']+)["']/gi;
    let optMatch;
    while ((optMatch = optionRegex.exec(match[1])) !== null) {
      const val = optMatch[1].trim();
      if (val && val !== '0' && val !== 'x' && val !== '') {
        deptIds.add(val);
      }
    }
  }

  // หรือลองดึงจาก Get_hr_department.php
  try {
    const headers = {
      Origin: ROCKET_BASE,
      Referer: ROCKET_BASE + '/hr/organization_chart.php',
      'X-Requested-With': 'XMLHttpRequest'
    };
    if (auth.cookie) {
      headers.Cookie = auth.cookie;
    }

    const body = new URLSearchParams();
    body.set('token', auth.token);
    body.set('key', auth.key);

    const res = await fetch(ROCKET_BASE + '/hr/ajax/organization_chart/Get_hr_department.php', {
      method: 'POST',
      headers: headers,
      body: body
    });

    if (res.status === 200) {
      const deptHtml = await res.text();
      const optRegex = /<option[^>]*value=["']([^"']+)["']/gi;
      let optMatch;
      while ((optMatch = optRegex.exec(deptHtml)) !== null) {
        const val = optMatch[1].trim();
        if (val && val !== '0' && val !== 'x' && val !== '') {
          deptIds.add(val);
        }
      }
    }
  } catch (e) {
    // ignore
  }

  return Array.from(deptIds);
}

function forceTextIfNumeric(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  const str = String(value).trim();
  return /^\d+$/.test(str) ? "'" + str : str;
}

function employeeToRow(emp, lastSync) {
  return [
    emp.position || '',
    emp.level || '',
    forceTextIfNumeric(emp.employeeId),
    emp.fullName || '',
    emp.nickname || '',
    forceTextIfNumeric(emp.desk),
    lastSync
  ];
}

async function main() {
  console.log('========== SYNC EMPLOYEE ORGANIZATION CHART (Node.js / GitHub Actions) ==========');

  const auth = await rocket.rocketLogin();
  console.log('LOGIN OK');

  const allEmployeesMap = new Map();

  // 1. ดึงหน้าหลัก organization_chart.php
  console.log('กำลังโหลดหน้า https://rocket75.com/hr/organization_chart.php ...');
  const mainHtml = await fetchOrgChartPage(auth);
  const mainEmployees = extractEmployeesFromHtml(mainHtml);
  console.log('พบพนักงานจากหน้าหลัก: ' + mainEmployees.length + ' คน');
  for (const emp of mainEmployees) {
    if (emp.employeeId) {
      allEmployeesMap.set(emp.employeeId, emp);
    }
  }

  // 2. ดึงจาก Table.php
  const tableHtml = await fetchOrgChartTableAjax(auth, '');
  if (tableHtml) {
    const tableEmployees = extractEmployeesFromHtml(tableHtml);
    console.log('พบพนักงานจาก Table.php: ' + tableEmployees.length + ' คน');
    for (const emp of tableEmployees) {
      if (emp.employeeId) {
        allEmployeesMap.set(emp.employeeId, emp);
      }
    }
  }

  // 3. ตรวจสอบแผนกและดึงเพิ่มเติมถ้ามีหลายแผนก
  const departmentIds = await fetchDepartmentIds(auth, mainHtml);
  if (departmentIds.length > 0) {
    console.log('พบแผนกทั้งหมด ' + departmentIds.length + ' แผนก: ' + departmentIds.join(', '));
    for (const deptId of departmentIds) {
      const deptHtml = await fetchOrgChartTableAjax(auth, deptId);
      if (deptHtml) {
        const deptEmployees = extractEmployeesFromHtml(deptHtml);
        for (const emp of deptEmployees) {
          if (emp.employeeId) {
            allEmployeesMap.set(emp.employeeId, emp);
          }
        }
      }
    }
  }

  const employeeList = Array.from(allEmployeesMap.values());
  console.log('รวมพนักงานทั้งหมดที่ไม่ซ้ำกัน: ' + employeeList.length + ' คน');

  // จัดเรียงตามรหัสพนักงาน
  employeeList.sort(function(a, b) {
    return (a.employeeId || '').localeCompare(b.employeeId || '');
  });

  // 4. บันทึกลง Google Sheets
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new Error('ไม่พบ SPREADSHEET_ID ใน environment variables');
  }

  const sheets = await sheetsLib.getSheetsClient();
  const sheetId = await sheetsLib.ensureSheetExists(sheets, spreadsheetId, EMPLOYEE_SHEET_NAME);

  const lastSync = rocket.formatDateTimeBangkok(new Date());
  const rows = employeeList.map(function(emp) {
    return employeeToRow(emp, lastSync);
  });

  await sheetsLib.replaceSheetData(sheets, spreadsheetId, sheetId, EMPLOYEE_SHEET_NAME, EMPLOYEE_HEADERS, rows);

  console.log('เขียนข้อมูลลงชีท "' + EMPLOYEE_SHEET_NAME + '" สำเร็จ ' + rows.length + ' แถว');
  console.log('DONE');
}

main().catch(function(err) {
  console.error('Sync ล้มเหลว:', err);
  process.exit(1);
});
