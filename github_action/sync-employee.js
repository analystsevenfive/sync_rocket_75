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
  'Company',
  'Department',
  'Team',
  'Position',
  'Level',
  'Employee ID',
  'Full Name',
  'Nickname',
  'Desk',
  'Last Sync'
];

function getLevelNumber(level) {
  const match = String(level || '').match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function employeeLabel(emp) {
  if (!emp) return '';
  const parts = [];
  if (emp.position) parts.push(emp.position);
  if (emp.fullName) parts.push(emp.fullName);
  if (emp.employeeId) parts.push(emp.employeeId);
  return parts.join(' - ');
}

function isExecutivePosition(position) {
  return /กรรมการ|ผู้บริหาร|บริหาร/.test(String(position || ''));
}

function isManagerPosition(position) {
  return /ผู้จัดการ|หัวหน้า/.test(String(position || ''));
}

function applyOrgContext(employees, context) {
  const stack = [];
  const defaults = context || {};

  return employees.map(function(emp) {
    const levelNum = getLevelNumber(emp.level);
    if (levelNum !== null) {
      while (stack.length > 0 && stack[stack.length - 1].levelNum <= levelNum) {
        stack.pop();
      }
    }

    const ancestors = stack.map(function(item) { return item.emp; });
    const manager = (isManagerPosition(emp.position) ? emp : null) || ancestors.slice().reverse().find(function(parent) {
      return isManagerPosition(parent.position);
    });

    const enriched = Object.assign({}, emp, {
      company: emp.company || defaults.company || '',
      department: emp.department || defaults.department || '',
      team: emp.team || employeeLabel(manager) || defaults.team || ''
    });

    if (levelNum !== null) {
      stack.push({ levelNum: levelNum, emp: enriched });
    }

    return enriched;
  });
}

function applyDepartmentContext(employees, department) {
  return employees.map(function(emp) {
    return Object.assign({}, emp, { department: department || '' });
  });
}

function applyTeamHierarchy(employees) {
  const stack = [];
  return employees.map(function(emp) {
    const levelNum = getLevelNumber(emp.level);
    if (levelNum !== null) {
      while (stack.length && stack[stack.length - 1].levelNum <= levelNum) stack.pop();
    }
    const ancestors = stack.map(function(item) { return item.emp; });
    const manager = isManagerPosition(emp.position) ? emp : ancestors.slice().reverse().find(function(parent) {
      return isManagerPosition(parent.position);
    });
    const enriched = Object.assign({}, emp, { team: employeeLabel(manager) });
    if (levelNum !== null) stack.push({ levelNum: levelNum, emp: enriched });
    return enriched;
  });
}

function mergeEmployee(existing, incoming) {
  if (!existing) return incoming;
  const merged = Object.assign({}, existing);
  Object.keys(incoming).forEach(function(key) {
    if ((merged[key] === undefined || merged[key] === null || merged[key] === '') &&
        incoming[key] !== undefined && incoming[key] !== null && incoming[key] !== '') {
      merged[key] = incoming[key];
    }
  });
  return merged;
}

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
function extractEmployeesFromHtml(html, context) {
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

  return applyOrgContext(employees, context);
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

  const res = await rocket.fetchWithTimeout(ROCKET_BASE + '/hr/organization_chart.php', {
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
    body.set('search_department', String(departmentId));
    body.set('department', String(departmentId));
  }

  const res = await rocket.fetchWithTimeout(ROCKET_BASE + '/hr/ajax/organization_chart/Table.php', {
    method: 'POST', headers, body
  });
  if (res.status === 200) return res.text();
  // The optional all-department endpoint may not exist. Once a department was
  // discovered, its fetch must succeed before replacing the directory.
  if (!departmentId && (res.status === 404 || res.status === 405)) return '';
  throw new Error('Organization chart department ' + (departmentId || 'all') + ' HTTP ' + res.status);

}

/**
 * ดึงรายการแผนกเพื่อดึงข้อมูลให้ครบทุกแผนก
 */
async function fetchDepartmentIds(auth, html, companyId) {
  const deptMap = new Map();

  function addDepartment(id, label) {
    const val = String(id || '').trim();
    if (val && val !== '0' && val !== 'x' && val !== '') {
      deptMap.set(val, cleanText(label || val));
    }
  }

  // ดึงจาก <select> ใน HTML
  const selectRegex = /<select[^>]*name=["'](?:department_id|hr_department_id|search_department)["'][^>]*>([\s\S]*?)<\/select>/gi;
  const match = selectRegex.exec(html);
  if (match) {
    const optionRegex = /<option[^>]*value=["']([^"']+)["'][^>]*>([\s\S]*?)<\/option>/gi;
    let optMatch;
    while ((optMatch = optionRegex.exec(match[1])) !== null) {
      addDepartment(optMatch[1], optMatch[2]);
    }
  }

  // Rocket has used generated select names in some versions. The visible
  // filter order is Company -> Department, so use the select following the
  // company list when the known department names are not present.
  if (deptMap.size === 0) {
    const selects = [];
    const anySelectRegex = /<select[^>]*>([\s\S]*?)<\/select>/gi;
    let selectMatch;
    while ((selectMatch = anySelectRegex.exec(String(html || ''))) !== null) {
      const options = [];
      const optionRegex = /<option[^>]*value=["']([^"']+)["'][^>]*>([\s\S]*?)<\/option>/gi;
      let optionMatch;
      while ((optionMatch = optionRegex.exec(selectMatch[1])) !== null) {
        const value = String(optionMatch[1] || '').trim();
        const label = cleanText(optionMatch[2] || '');
        if (value && value !== '0' && value !== 'x' && label) {
          options.push({ id: value, name: label });
        }
      }
      selects.push(options);
    }

    const companyIndex = selects.findIndex(function(options) {
      return options.filter(function(option) {
        return /^[A-Z0-9]{2,4}\s*-\s*/i.test(option.name);
      }).length >= 2;
    });
    if (companyIndex >= 0) {
      for (let i = companyIndex + 1; i < selects.length; i++) {
        if (selects[i].length > 0) {
          selects[i].forEach(function(dept) { addDepartment(dept.id, dept.name); });
          break;
        }
      }
    }
  }

  // หรือลองดึงจาก Get_hr_department.php
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
  if (companyId) {
    body.set('company_id', String(companyId));
    body.set('hr_company_id', String(companyId));
    body.set('search_company', String(companyId));
    body.set('company', String(companyId));
    body.set('id', String(companyId));
  }

  const res = await rocket.fetchWithTimeout(ROCKET_BASE + '/hr/ajax/organization_chart/Get_hr_department.php', {
    method: 'POST',
    headers: headers,
    body: body
  });

  if (res.status !== 200 && res.status !== 404 && res.status !== 405) {
    throw new Error('Department discovery HTTP ' + res.status);
  }
  if (res.status === 200) {
    const deptHtml = await res.text();
    const optRegex = /<option[^>]*value=["']([^"']+)["'][^>]*>([\s\S]*?)<\/option>/gi;
    let optMatch;
    while ((optMatch = optRegex.exec(deptHtml)) !== null) {
      addDepartment(optMatch[1], optMatch[2]);
    }
    if (deptMap.size === 0) {
      try {
        const data = JSON.parse(deptHtml);
        const rows = Array.isArray(data) ? data : (data.data || data.rows || data.result || []);
        if (Array.isArray(rows)) {
          rows.forEach(function(row) {
            addDepartment(
              row.id || row.value || row.department_id || row.hr_department_id,
              row.name || row.label || row.text || row.department_name
            );
          });
        }
      } catch (e) {
        // HTML option responses are handled above.
      }
    }
  }

  return Array.from(deptMap.entries()).map(function(entry) {
    return { id: entry[0], name: entry[1] };
  });
}

function extractSelectedOption(html, selectNames) {
  if (!html) return '';
  const names = selectNames.map(function(name) {
    return String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('|');
  const selectRegex = new RegExp('<select[^>]*(?:name|id)=["\'](?:' + names + ')["\'][^>]*>([\\s\\S]*?)<\\/select>', 'i');
  const selectMatch = String(html).match(selectRegex);
  if (!selectMatch) return null;

  const optionRegex = /<option([^>]*)value=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi;
  let first = '';
  let optionMatch;
  while ((optionMatch = optionRegex.exec(selectMatch[1])) !== null) {
    const attrs = optionMatch[1] || '';
    const value = String(optionMatch[2] || '').trim();
    const label = cleanText(optionMatch[3] || '');
    if (!label || value === '0' || value === 'x') continue;
    const option = { value: value, label: label };
    if (!first) first = option;
    if (/\bselected\b/i.test(attrs)) return option;
  }
  return first;
}

function extractSelectedOptionText(html, selectNames) {
  const option = extractSelectedOption(html, selectNames);
  return option ? option.label : '';
}

function extractCompanySelection(html) {
  const direct = extractSelectedOption(html, [
    'company', 'company_id', 'hr_company', 'hr_company_id',
    'search_company', 'search_hr_company'
  ]);
  if (direct) return direct;

  const selectRegex = /<select[^>]*>([\s\S]*?)<\/select>/gi;
  let selectMatch;
  while ((selectMatch = selectRegex.exec(String(html || ''))) !== null) {
    const options = [];
    const optionRegex = /<option([^>]*)value=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi;
    let optionMatch;
    while ((optionMatch = optionRegex.exec(selectMatch[1])) !== null) {
      const value = String(optionMatch[2] || '').trim();
      const label = cleanText(optionMatch[3] || '');
      if (value && value !== '0' && value !== 'x' && label) {
        options.push({ attrs: optionMatch[1] || '', value: value, label: label });
      }
    }
    const companyOptions = options.filter(function(option) {
      return /^[A-Z0-9]{2,4}\s*-\s*/i.test(option.label);
    });
    if (companyOptions.length >= 2) {
      const selected = companyOptions.find(function(option) {
        return /\bselected\b/i.test(option.attrs);
      });
      return selected || companyOptions[0];
    }
  }
  return null;
}

function extractCompanyText(html) {
  const company = extractCompanySelection(html);
  return company ? company.label : '';
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
    emp.company || '',
    emp.department || '',
    emp.team || '',
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
  const companySelection = extractCompanySelection(mainHtml);
  const baseContext = {
    company: companySelection ? companySelection.label : '',
    department: '',
    team: ''
  };
  const mainEmployees = extractEmployeesFromHtml(mainHtml, baseContext);
  console.log('พบพนักงานจากหน้าหลัก: ' + mainEmployees.length + ' คน');
  for (const emp of mainEmployees) {
    if (emp.employeeId) {
      allEmployeesMap.set(emp.employeeId, mergeEmployee(allEmployeesMap.get(emp.employeeId), emp));
    }
  }

  // 2. ดึงจาก Table.php
  const tableHtml = await fetchOrgChartTableAjax(auth, '');
  if (tableHtml) {
    const tableEmployees = extractEmployeesFromHtml(tableHtml, baseContext);
    console.log('พบพนักงานจาก Table.php: ' + tableEmployees.length + ' คน');
    for (const emp of tableEmployees) {
      if (emp.employeeId) {
        allEmployeesMap.set(emp.employeeId, mergeEmployee(allEmployeesMap.get(emp.employeeId), emp));
      }
    }
  }

  // 3. ตรวจสอบแผนกและดึงเพิ่มเติมถ้ามีหลายแผนก
  const departmentIds = await fetchDepartmentIds(auth, mainHtml, companySelection ? companySelection.value : '');
  let departmentFetchEmployeeCount = 0;
  if (departmentIds.length > 0) {
    console.log('พบแผนกทั้งหมด ' + departmentIds.length + ' แผนก: ' + departmentIds.map(function(d) { return d.id || d; }).join(', '));
    for (const dept of departmentIds) {
      const deptId = dept.id || dept;
      const deptHtml = await fetchOrgChartTableAjax(auth, deptId);
      if (deptHtml) {
        const deptEmployees = applyTeamHierarchy(applyDepartmentContext(
          extractEmployeesFromHtml(deptHtml, baseContext), dept.name
        ));
        departmentFetchEmployeeCount += deptEmployees.length;
        for (const emp of deptEmployees) {
          if (emp.employeeId) {
            const previous = allEmployeesMap.get(emp.employeeId);
            allEmployeesMap.set(emp.employeeId, previous
              ? Object.assign({}, mergeEmployee(previous, emp), {
                department: emp.department,
                team: emp.team
              })
              : emp);
          }
        }
      }
    }
  }

  const employeeList = Array.from(allEmployeesMap.values());
  console.log('รวมพนักงานทั้งหมดที่ไม่ซ้ำกัน: ' + employeeList.length + ' คน');

  // จัดเรียงตามรหัสพนักงาน
  if (employeeList.length === 0) {
    throw new Error("No employees parsed; keeping previous sheet data.");
  }

  if (departmentIds.length === 0) {
    throw new Error('No departments discovered; keeping previous sheet data.');
  }
  if (departmentFetchEmployeeCount === 0) {
    throw new Error('Department tables returned no employees; keeping previous sheet data.');
  }

  const missingDepartments = employeeList.filter(function(emp) { return !emp.department; }).length;
  if (missingDepartments > 0) {
    throw new Error('Department missing for ' + missingDepartments + ' employees; keeping previous sheet data.');
  }
  const missingTeams = employeeList.filter(function(emp) { return !emp.team; }).length;
  if (missingTeams > 0) {
    throw new Error('Team hierarchy missing for ' + missingTeams + ' employees; keeping previous sheet data.');
  }

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
