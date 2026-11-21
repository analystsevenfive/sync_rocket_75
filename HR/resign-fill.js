/**
 * RESIGN FILL — GitHub Actions / Playwright
 * MODE=dry-run กรอกและตรวจสอบโดยไม่บันทึก
 * MODE=submit บันทึกจริงเมื่อ CONFIRM_SUBMIT="SUBMIT <รหัสพนักงาน>"
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const rocket = require('../github_action/lib/rocket-client');
const sheetsLib = require('../github_action/lib/sheets-client');

const SOURCE_SPREADSHEET_ID = '1H2K2gSnoP1xNTqDyZ51nMFlBlrwx2Es5GDquwHPPTGE';
const SOURCE_SHEET_NAME = 'employee for resign';
const ROCKET_URL = 'https://rocket75.com/hr/resignation_list.php';
const SCREENSHOT_DIR = path.resolve(process.env.SCREENSHOT_DIR || 'resign-artifacts');
const DATE = /^\d{2}\/\d{2}\/\d{4}$/;
// แต่ละคอลัมน์รับได้หลายชื่อ (ชื่อแรกที่พบในแถวหัวตารางจะถูกใช้)
const REQUIRED_HEADERS = {
  code: ['empcode'], name: ['name'], surname: ['surname'],
  status: ['working status', 'working status web hr'],
  lastDay: ['วันทำงานสุดท้าย'], effectiveDate: ['วันที่พ้นสภาพ'], reason: ['สาเหตุลาออก', 'สาเหตุ']
};
// ต้องได้รับอนุมัติในคอลัมน์ update statatus rocket ก่อนจึงจะกรอก Rocket ได้
const APPROVAL_HEADERS = ['update statatus rocket', 'update status rocket'];
const APPROVAL_VALUE = 'approve update rocket';
const compact = value => String(value || '').replace(/\s+/g, '').toLowerCase();

function parseRows(values) {
  const [header = [], ...rows] = values || [];
  const names = header.map(value => String(value || '').trim().toLowerCase());
  const indexes = {};
  const missing = [];
  for (const [key, labels] of Object.entries(REQUIRED_HEADERS)) {
    const label = labels.find(item => names.includes(item.toLowerCase()));
    indexes[key] = label ? names.indexOf(label.toLowerCase()) : -1;
    if (indexes[key] < 0) missing.push(labels.join(' / '));
  }
  const approvalIndexes = names.map((name, index) => APPROVAL_HEADERS.includes(name) ? index : -1)
    .filter(index => index >= 0);
  if (!approvalIndexes.length) missing.push(APPROVAL_HEADERS[0]);
  if (missing.length) throw new Error(`Sheet is missing columns: ${missing.join(', ')}`);
  return rows.map((row, offset) => ({
    sheetRow: offset + 2,
    ...Object.fromEntries(Object.keys(REQUIRED_HEADERS).map(key =>
      [key, String(row[indexes[key]] == null ? '' : row[indexes[key]]).trim()])),
    approved: approvalIndexes.some(index => compact(row[index]) === compact(APPROVAL_VALUE))
  })).filter(row => row.code);
}

function selectEmployee(rows, employeeCode) {
  const matches = rows.filter(row => row.code === employeeCode);
  if (!matches.length) throw new Error(`ไม่พบรหัส ${employeeCode} ในแท็บ ${SOURCE_SHEET_NAME}`);
  if (matches.length > 1) throw new Error(`พบรหัส ${employeeCode} ซ้ำ ${matches.length} แถว`);
  const row = matches[0];
  // การอนุมัติคือเงื่อนไขหลัก: สถานะ web hr อาจยังเป็น Working จนกว่าจะพ้นวันทำงานสุดท้าย
  if (!row.approved) throw new Error(`ยังไม่อนุมัติ: update statatus rocket ต้องเป็น "${APPROVAL_VALUE}"`);
  if (!DATE.test(row.lastDay)) throw new Error(`วันทำงานสุดท้ายไม่ถูกต้อง: ${row.lastDay || '(ว่าง)'}`);
  if (!DATE.test(row.effectiveDate)) throw new Error(`วันที่พ้นสภาพไม่ถูกต้อง: ${row.effectiveDate || '(ว่าง)'}`);
  if (!row.reason) throw new Error('สาเหตุลาออกว่าง');
  return row;
}

async function readEmployee(employeeCode) {
  const sheets = await sheetsLib.getSheetsClient();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SOURCE_SPREADSHEET_ID, fields: 'sheets.properties(title)'
  });
  if (!meta.data.sheets.some(sheet => sheet.properties.title === SOURCE_SHEET_NAME)) {
    throw new Error(`ไม่พบแท็บ ${SOURCE_SHEET_NAME}`);
  }
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: SOURCE_SPREADSHEET_ID, range: `'${SOURCE_SHEET_NAME}'!A:O`
  });
  return selectEmployee(parseRows(result.data.values || []), employeeCode);
}

async function fillForm(page, row) {
  await page.goto(ROCKET_URL, { waitUntil: 'domcontentloaded' });
  if (!page.url().includes('/hr/resignation_list.php')) {
    throw new Error(`Rocket redirected away from resignation page: ${page.url()}`);
  }
  // ป้องกันการบันทึกใบลาออกซ้ำ ก่อนเปิดหรือกรอกฟอร์ม
  const existingRows = page.locator('table tbody tr').filter({ hasText: row.code });
  if (await existingRows.count()) {
    throw new Error(`รหัส ${row.code} มีรายการลาออกใน Rocket อยู่แล้ว`);
  }
  await page.waitForFunction(() =>
    typeof window.ModalResigntion === 'function' && typeof window.searchEmployee === 'function');
  const result = await page.evaluate(async data => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const waitFor = async (check, label, timeout = 15000) => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        if (check()) return;
        await sleep(200);
      }
      throw new Error(`รอ${label}นานเกินไป`);
    };
    const modal = document.getElementById('myModalTemp');
    if (!modal) throw new Error('ไม่พบพื้นที่ฟอร์มแจ้งลาออก');
    if (!modal.querySelector('#form-add')) window.ModalResigntion();
    await waitFor(() => modal.querySelector('#form-add'), 'ฟอร์มแจ้งลาออก');
    const field = id => modal.querySelector('#' + id);
    if (field('user_code')) field('user_code').value = '';
    window.searchEmployee(data.code);
    await waitFor(() => field('user_code')?.value === data.code && field('user_id')?.value,
      'ผลค้นหาพนักงาน');
    const labelOf = input => {
      for (let element = input.parentElement; element && element !== modal; element = element.parentElement) {
        const label = element.querySelector('label');
        if (label) return label.textContent.trim();
      }
      return '';
    };
    const dateInputs = [...modal.querySelectorAll('input.form-datepicker, .form-datepicker input')];
    const setDate = (label, value) => {
      const input = dateInputs.find(item => labelOf(item).startsWith(label));
      if (!input) throw new Error(`ไม่พบช่อง ${label}`);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return input.value;
    };
    const reasonSelect = [...modal.querySelectorAll('select')].find(select =>
      [...select.options].some(option => option.textContent.trim() === data.reason));
    if (!reasonSelect) throw new Error(`ไม่พบสาเหตุ "${data.reason}" ใน Rocket`);
    const reasonOption = [...reasonSelect.options].find(option => option.textContent.trim() === data.reason);
    reasonSelect.value = reasonOption.value;
    reasonSelect.dispatchEvent(new Event('input', { bubbles: true }));
    reasonSelect.dispatchEvent(new Event('change', { bubbles: true }));
    if (window.jQuery && typeof window.jQuery(reasonSelect).selectpicker === 'function') {
      window.jQuery(reasonSelect).selectpicker('refresh');
    }
    return {
      userCode: field('user_code').value,
      fullName: field('fullname')?.value || '',
      effectiveDate: setDate('วันที่มีผลลาออก', data.effectiveDate),
      lastDay: setDate('วันที่ทำงานวันสุดท้าย', data.lastDay),
      reason: reasonSelect.options[reasonSelect.selectedIndex]?.textContent.trim() || ''
    };
  }, row);
  if (result.userCode !== row.code || result.effectiveDate !== row.effectiveDate ||
      result.lastDay !== row.lastDay || compact(result.reason) !== compact(row.reason)) {
    throw new Error('ค่าที่กรอกใน Rocket ไม่ตรงกับชีต');
  }
  if (!compact(result.fullName).includes(compact(row.name))) {
    throw new Error(`ชื่อไม่ตรง: ชีต "${row.name} ${row.surname}" / Rocket "${result.fullName}"`);
  }
  return result;
}

async function submitForm(page, employeeCode) {
  const submit = page.locator('#myModalTemp').getByRole('button', { name: 'ยืนยัน', exact: true });
  if (await submit.count() !== 1) throw new Error('ไม่พบปุ่มยืนยันที่แน่นอนเพียงหนึ่งปุ่ม');
  await submit.click();
  const secondary = page.locator('.swal2-confirm:visible, .bootbox-accept:visible');
  try {
    await secondary.first().waitFor({ state: 'visible', timeout: 2000 });
    await secondary.first().click();
  } catch (_) { /* บางเวอร์ชันไม่มี confirmation ซ้ำ */ }
  await page.waitForTimeout(3000);
  if (page.url().includes('/index.php')) throw new Error('Session Rocket หมดอายุระหว่างบันทึก');
  console.log(`SUBMIT completed for ${employeeCode}; verify the screenshot artifact.`);
}

async function main() {
  // Dependencies are installed from github_action/package.json, while this entrypoint lives in HR/.
  const playwrightPath = require.resolve('playwright', {
    paths: [path.resolve(__dirname, '../github_action')]
  });
  const { chromium } = require(playwrightPath);
  const employeeCode = String(process.env.EMPLOYEE_CODE || '').trim();
  const mode = String(process.env.MODE || 'dry-run').trim().toLowerCase();
  if (!/^\d{6,8}$/.test(employeeCode)) throw new Error('EMPLOYEE_CODE must contain 6-8 digits');
  if (!['dry-run', 'submit'].includes(mode)) throw new Error('MODE must be dry-run or submit');
  if (mode === 'submit' && process.env.CONFIRM_SUBMIT !== `SUBMIT ${employeeCode}`) {
    throw new Error(`Submit blocked: CONFIRM_SUBMIT must equal "SUBMIT ${employeeCode}"`);
  }
  const row = await readEmployee(employeeCode);
  console.log(`Validated sheet row ${row.sheetRow} for ${employeeCode}; mode=${mode}`);
  const auth = await rocket.rocketLogin();
  // Rocket pages read token/key from localStorage (not a PHPSESSID cookie); the cookie is optional.
  if (!auth.token || !auth.key) throw new Error('Rocket login did not return token/key');
  const sessionId = String(auth.cookie || '').match(/PHPSESSID=([^;]+)/i)?.[1];
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ locale: 'th-TH', timezoneId: 'Asia/Bangkok' });
    await context.addInitScript(({ token, key }) => {
      if (/(^|\.)rocket75\.com$/.test(location.hostname)) {
        localStorage.setItem('token', token);
        localStorage.setItem('key', key);
      }
    }, { token: auth.token, key: auth.key });
    if (sessionId) {
      await context.addCookies([{ name: 'PHPSESSID', value: sessionId, domain: 'rocket75.com', path: '/', secure: true }]);
    }
    const page = await context.newPage();
    const filled = await fillForm(page, row);
    console.log(`Filled and verified ${employeeCode} (${filled.fullName}); reason=${filled.reason}`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${employeeCode}-filled.png`), fullPage: true });
    if (mode === 'submit') {
      await submitForm(page, employeeCode);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${employeeCode}-submitted.png`), fullPage: true });
    } else {
      console.log('DRY RUN complete: no submit button was clicked.');
    }
  } finally {
    await browser.close();
  }
}

if (require.main === module) main().catch(error => {
  console.error('Resign fill failed:', error.message);
  process.exit(1);
});
module.exports = { parseRows, selectEmployee, REQUIRED_HEADERS };
