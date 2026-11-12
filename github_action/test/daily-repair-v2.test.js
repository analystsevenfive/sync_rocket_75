const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const rocket = require('../lib/rocket-client');

// โครง HTML ย่อจากหน้า ticket_checkrepair_view.php จริง (ข้อมูลสมมติ)
const S3 = 'https://rocket75.s3.ap-southeast-2.amazonaws.com';
const signed = file => `${S3}/${file}?X-Amz-Algorithm=AWS4-HMAC-SHA256&amp;X-Amz-Expires=59940&amp;X-Amz-Signature=abc`;
const mediaBlock = (label, file) => `
  <div class="col-md-3 mb-2 mr-2"><div class="row mb-2 text-center">
    <b>
        ${label}                                </b>
    <a href="${signed(file)}" target="_blank"><img alt="Pic" src="${signed(file)}"></a>
  </div></div>`;

const DETAIL_HTML = `
  <div class="col-md-3 mb-2"><div class="row mb-2"><h5>เวลาเข้างาน</h5></div>
    <div class="row mb-2"><label class="">
      10/11/2026 09:02 <a class="btn btn-primary btn-icon" href="http://www.google.com/maps/place/13.6692019,100.6343380" target=" _blank"><i class="fa fa-map-marker"></i></a>
    </label></div></div>
  <div class="col-md-3 mb-2"><div class="row mb-2"><h5>เวลาเสร็จงาน</h5></div>
    <div class="row mb-2"><label class="">10/11/2026 13:35</label></div></div>
  <div class="row mb-8"><div class="col-12 mb-5"><h5>รูปภาพเข้างาน</h5></div>
    ${mediaBlock('GPS', 'checkin_img/gps.png')}
    ${mediaBlock('รูปถ่ายคู่กับหน้าร้าน', 'checkin_img/selfie.jpeg')}
    ${mediaBlock('หน้าร้าน', 'checkin_img/front.jpeg')}
  </div>
  <div class="row mb-8">
    <div class="col-md-3"><b>วีดีโอทดสอบ</b><video><source src="${signed('checkout_img/v.mov')}" type="video/mp4"></video></div>
    ${mediaBlock('รูปถ่ายใบงาน', 'checkout_img/workorder.jpeg')}
  </div>`;

test('parseCheckinMedia extracts check-in GPS and the three requested photos', () => {
  const media = rocket.parseCheckinMedia(DETAIL_HTML);
  assert.equal(media.gps, '13.6692019,100.6343380');
  assert.equal(media.gpsPhotoUrl, `${S3}/checkin_img/gps.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=59940&X-Amz-Signature=abc`);
  // "หน้าร้าน" ต้องไม่ถูกสับสนกับ "รูปถ่ายคู่กับหน้าร้าน"
  assert.match(media.storefrontPhotoUrl, /checkin_img\/selfie\.jpeg/);
  assert.match(media.workOrderPhotoUrl, /checkout_img\/workorder\.jpeg/);
});

test('parseCheckinMedia returns blanks when the technician has not checked in yet', () => {
  const html = '<h5>เวลาเข้างาน</h5><label> - </label><h5>เวลาเสร็จงาน</h5><b>GPS</b><div>ไม่มีรูป</div>';
  assert.deepEqual({ ...rocket.parseCheckinMedia(html) },
    { gps: '', gpsPhotoUrl: '', storefrontPhotoUrl: '', workOrderPhotoUrl: '' });
  assert.equal(rocket.parseCheckinMedia('').gps, '');
});

test('extractCheckinGps ignores a map link that belongs to check-out', () => {
  const html = '<h5>เวลาเข้างาน</h5><label>-</label><h5>เวลาเสร็จงาน</h5>' +
    '<a href="http://www.google.com/maps/place/1.5,2.5">pin</a>';
  assert.equal(rocket.extractCheckinGps(html), '');
});

function loadScript(name, mocks) {
  const file = path.join(__dirname, '..', name);
  const source = fs.readFileSync(file, 'utf8').replace(/main\(\)\.catch\([\s\S]*$/, '');
  const context = vm.createContext({
    require: id => mocks[id] || (id === './lib/rocket-client' ? rocket : {}),
    console: { log() {}, error() {} },
    process: { env: { SPREADSHEET_ID: 'test' } },
    setTimeout, clearTimeout, Buffer, URLSearchParams
  });
  vm.runInContext(source, context, { filename: file });
  return context;
}

async function runSync(name) {
  const today = rocket.computeTodayRangeBangkok().start;
  const written = {};
  const script = loadScript(name, {
    './lib/rocket-client': {
      ...rocket,
      rocketLogin: async () => ({ cookie: 'mock' }),
      getParentTicketHtml: async () => '',
      extractParentTicketIds: () => ['10'],
      extractParentToCustomerCodeMap: () => ({}),
      extractParentToProductIdMap: () => ({}),
      getCheckRepairHtml: async () => '',
      extractCheckRepairIds: () => ['101'],
      extractCheckRepairInfo: () => ({ '101': { technicians: 'ช่างหนึ่ง', team: 'A' } }),
      getTicketDetailHtml: async () => DETAIL_HTML,
      parseTicketDetail: () => ({ ticketId: '101', ticketNo: 'BKRM01.R01', appointment: `${today} 09:00`, startTime: '10/11/2026 09:02', status: 'กำลังทำ', technician: 'ช่างหนึ่ง' }),
      getInspectorModalHtml: async () => '',
      parseInspectorModal: () => ({ status: '', type: 'งานซ่อม' }),
      getModalProductHtml: async () => '',
      parseSalesInvoiceNo: () => ''
    },
    './lib/work-order-report': { getWorkOrderSentReport: async () => new Map([['BKRM01.R01', '']]) },
    './lib/sheets-client': {
      getSheetsClient: async () => ({}),
      ensureSheetExists: async (sheets, id, name) => { written.ensured = name; return 1; },
      replaceSheetData: async (sheets, id, sheetId, name, headers, rows) => Object.assign(written, { name, headers, rows })
    }
  });
  await script.main();
  return { script, written };
}

test('V2 writes Daily Repair Update V2 with check-in time after GPS and photo links', async () => {
  const { written } = await runSync('sync-daily-repair-v2.js');
  // คอลัมน์เดิมต้องตรงกับชีท Daily Repair Update ทุกตัว แล้วต่อท้ายด้วย 5 คอลัมน์ใหม่
  const baseHeaders = (await runSync('sync-daily-repair.js')).written.headers;

  assert.equal(written.ensured, 'Daily Repair Update V2');
  assert.equal(written.name, 'Daily Repair Update V2');
  assert.deepEqual(Array.from(written.headers), [...baseHeaders,
    'GPS Coordinates', 'Check-in Time', 'Check-in Photo (GPS)', 'Storefront Photo', 'Work Order Photo']);

  const row = written.rows[0];
  assert.equal(row.length, written.headers.length);
  assert.equal(row[1], 'BKRM01.R01');
  const extra = row.slice(baseHeaders.length);
  assert.equal(extra[0], '=HYPERLINK("https://www.google.com/maps/place/13.6692019,100.6343380","13.6692019,100.6343380")');
  assert.equal(extra[1], '10/11/2026 09:02');
  // รูปเป็น URL ตรงๆ ไม่ใช่สูตร HYPERLINK
  assert.equal(extra[2], `${S3}/checkin_img/gps.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=59940&X-Amz-Signature=abc`);
  assert.match(extra[3], /^https:\/\/rocket75\.s3\S*checkin_img\/selfie\.jpeg\?/);
  assert.match(extra[4], /^https:\/\/rocket75\.s3\S*checkout_img\/workorder\.jpeg\?/);
});

test('original Daily Repair Update sheet keeps its columns unchanged', async () => {
  const { script, written } = await runSync('sync-daily-repair.js');
  assert.equal(written.name, 'Daily Repair Update');
  assert.deepEqual(Array.from(written.headers), Array.from(vm.runInContext("HEADERS", script)));
  assert.equal(written.rows[0].length, vm.runInContext("HEADERS.length", script));
});

test('checkinMediaCells leaves cells blank when there is no media', () => {
  const script = loadScript('sync-daily-repair-v2.js', {});
  assert.deepEqual(Array.from(script.checkinMediaCells({})), ['', '', '', '', '']);
});
