const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const rocket = require('../lib/rocket-client');
const sheetsLib = require('../lib/sheets-client');

// Load script functions without running a production sync or needing credentials.
function loadScript(name, mocks = {}) {
  const file = path.join(__dirname, '..', name);
  const source = fs.readFileSync(file, 'utf8').replace(/main\(\)\.catch\([\s\S]*$/, '');
  const context = vm.createContext({
    require: id => mocks[id] || (id === './lib/rocket-client' ? rocket : {}),
    console: { log() {}, error() {} }, process: { env: { SPREADSHEET_ID: 'test' } },
    setTimeout, clearTimeout, Buffer, URLSearchParams
  });
  vm.runInContext(source, context, { filename: file });
  return context;
}

function fakeSheets({ failWrite = false, columns = 26 } = {}) {
  const state = { values: [['old header', 'other'], ['old ticket', 'keep']], writes: [], columns };
  const sheets = { spreadsheets: {
    get: async () => ({ data: { sheets: [{ properties: {
      sheetId: 0, gridProperties: { rowCount: 1000, columnCount: state.columns }
    } }] } }),
    batchUpdate: async req => {
      for (const r of req.requestBody.requests) {
        const grid = r.updateSheetProperties?.properties.gridProperties;
        if (grid?.columnCount) state.columns = grid.columnCount;
      }
      return { data: {} };
    },
    values: {
      get: async () => ({ data: { values: state.values } }),
      clear: async () => { state.values = []; },
      update: async req => {
        if (failWrite && !req.range.endsWith('1')) throw new Error('write failed');
        state.writes.push(req);
      },
      batchUpdate: async req => {
        if (failWrite) throw new Error('write failed');
        state.writes.push(...req.requestBody.data);
      }
    }
  } };
  return { sheets, state };
}

test('snapshot write failure does not erase previous data (both layouts)', async () => {
  for (const summary of [false, true]) {
    const { sheets, state } = fakeSheets({ failWrite: true });
    const previous = structuredClone(state.values);
    const args = [sheets, 'test', 0, 'Jobs'];
    await assert.rejects(summary
      ? sheetsLib.replaceSheetDataWithSummary(...args, 'summary', ['ID', 'Name'], [['new', 'value']])
      : sheetsLib.replaceSheetData(...args, ['ID', 'Name'], [['new', 'value']]), /write failed/);
    assert.deepEqual(state.values, previous);
  }
});

test('snapshot expands columns and clears stale cells within the replacement write', async () => {
  const { sheets, state } = fakeSheets();
  await sheetsLib.replaceSheetData(sheets, 'test', 0, 'Jobs', Array(36).fill('Header'), []);
  assert.ok(state.columns >= 36);
  assert.equal(state.writes.length, 1);
  assert.deepEqual(state.writes[0].values[1], Array(36).fill(''));
});

test('partial fetch failure aborts a full snapshot after retry', async () => {
  let failures = 0;
  await assert.rejects(rocket.mapConcurrentStrict([1, 2], 2, async id => {
    if (id === 2) { failures++; throw new Error('offline'); }
    return id;
  }), /offline/);
  assert.equal(failures, 2);
  assert.deepEqual(await rocket.mapConcurrentStrict([2, 1], 2, async id => id), [2, 1]);
});

test('gasoline keeps different technicians on separate rows and deduplicates repeated input', async () => {
  const script = loadScript('sync-gasoline.js');
  const { sheets, state } = fakeSheets();
  const ctx = { index: { 'BK1__Alice': 3, BK1: 3 }, hasFormula: { 3: true }, lastRow: 3 };
  const row = { ticketNo: 'BK1', technician: 'Bob', counted: 1 };
  await script.upsertRows(sheets, 'test', 0, 'Gasoline', [row, row], ctx, {}, {}, 'now');
  assert.equal(ctx.lastRow, 4);
  assert.equal(ctx.index['BK1__Alice'], 3);
  assert.equal(ctx.index['BK1__Bob'], 4);
  assert.ok(state.writes.every(write => !write.range.includes('A3:')));
});

test('backfill locates current and legacy headers and updates only missing Ticket No cells', async () => {
  for (const values of [
    [['summary'], ['Inspection Status', 'Sales Invoice No.', 'Ticket ID', 'Parent Ticket ID', 'Parent Ticket No', 'Ticket No'], ['OK', 'INV', '42', '9', 'BK1', '']],
    [['Ticket ID', 'Parent Ticket ID', 'Parent Ticket No', 'Ticket No'], ['42', '9', 'BK1', '']]
  ]) {
    const writes = [];
    const sheets = { spreadsheets: { values: {
      get: async () => ({ data: { values } }),
      batchUpdate: async req => { writes.push(...req.requestBody.data); }
    } } };
    const script = loadScript('backfill-ticket-no.js', {
      './lib/sheets-client': { getSheetsClient: async () => sheets, columnLetter: sheetsLib.columnLetter },
      './lib/rocket-client': {
        rocketLogin: async () => ({}), getTicketDetailHtml: async () => '',
        parseTicketDetail: () => ({ ticketId: '42', ticketNo: 'BK1.R01' }),
        mapConcurrentStrict: rocket.mapConcurrentStrict
      }
    });
    await script.main();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].range, values.length === 3 ? "'Tickets'!F3" : "'Tickets'!D2");
    assert.equal(writes[0].values[0][0], 'BK1.R01');
  }
});

test('HTTP timeout covers a stalled body after response headers arrive', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('partial');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // Stop the baseline test from hanging if the body timeout is broken.
  const watchdog = setTimeout(() => server.closeAllConnections(), 500);
  try {
    const res = await rocket.fetchWithTimeout(`http://127.0.0.1:${server.address().port}`, {}, 80);
    await assert.rejects(res.text(), err => /abort|timeout/i.test(err.name));
  } finally {
    clearTimeout(watchdog);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('legacy Apps Script parser accepts fast links and row IDs', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../trick.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source.match(/function extractCheckRepairIds_\([\s\S]*?\n}/)[0], context);
  assert.deepEqual(Array.from(context.extractCheckRepairIds_('<a href="ticket_checkrepair_view_fast.php?id=42">job</a><tr id="tr_43"></tr>')), ['42', '43']);
});

for (const name of ['sync-tickets.js', 'sync-trick2.js', 'sync-daily-repair.js',
  'sync-yesterday-jobs.js', 'sync-tomorrow-plan.js', 'sync-7day-installation-plan.js']) {
  test(name + ' refuses to publish if one parent fetch fails', async () => {
    let writes = 0;
    const script = loadScript(name, {
      './lib/rocket-client': {
        ...rocket,
        rocketLogin: async () => ({}),
        getParentTicketHtml: async () => '', extractParentTicketIds: () => ['1', '2'],
        getCheckRepairHtml: async id => { if (id === '2') throw new Error('offline'); return ''; },
        extractCheckRepairIds: () => ['10']
      },
      './lib/sheets-client': { getSheetsClient: async () => { writes++; throw new Error('unexpected write'); } }
    });
    if (name.includes('7day')) script.extractParentRowsMap = () => ({
      '1': { ticketNo: 'BKIN1' }, '2': { ticketNo: 'BKIN2' }
    });
    await assert.rejects(script.main(), /offline/);
    assert.equal(writes, 0);
  });
}

test('modal HTTP errors remain errors so snapshot callers can retry and stop', async () => {
  const original = global.fetch;
  global.fetch = async () => new Response('Unavailable', { status: 503 });
  try {
    await assert.rejects(rocket.getInspectorModalHtml('1', {}), /HTTP 503/);
    await assert.rejects(rocket.getModalProductHtml('1', {}), /HTTP 503/);
  } finally { global.fetch = original; }
});

test('empty employee scrape cannot replace the existing directory', async () => {
  const script = loadScript('sync-employee.js', {
    './lib/rocket-client': { rocketLogin: async () => ({}) }
  });
  script.fetchOrgChartPage = async () => '';
  script.fetchOrgChartTableAjax = async () => '';
  script.fetchDepartmentIds = async () => [];
  await assert.rejects(script.main(), /No employees parsed/);
});

test('HTTP 200 login/blank pages are not mistaken for an empty ticket table', async () => {
  const original = global.fetch;
  try {
    for (const html of ['', '<html>Session expired</html>', '<table></table><input type="password">']) {
      global.fetch = async () => new Response(html);
      await assert.rejects(rocket.getParentTicketHtml({}, '', ''), /did not return a ticket table/);
    }
    const emptyTable = '<table><tbody></tbody></table>';
    global.fetch = async () => new Response(emptyTable);
    assert.equal(await rocket.getParentTicketHtml({}, '', ''), emptyTable);
  } finally { global.fetch = original; }
});

test('parent ticket table retries a transient failure', async () => {
  const original = global.fetch;
  let attempts = 0;
  global.fetch = async () => {
    attempts++;
    return attempts === 1
      ? new Response('Busy', { status: 503 })
      : new Response('<table><tbody></tbody></table>');
  };
  try {
    assert.equal(await rocket.getParentTicketHtml({}, '', ''), '<table><tbody></tbody></table>');
    assert.equal(attempts, 2);
  } finally { global.fetch = original; }
});

test('a discovered employee department cannot silently fail', async () => {
  const script = loadScript('sync-employee.js', {
    './lib/rocket-client': { ROCKET_BASE: 'https://example.test',
      fetchWithTimeout: async () => ({ status: 503 }) }
  });
  await assert.rejects(script.fetchOrgChartTableAjax({}, 'known-department'), /HTTP 503/);
  await assert.rejects(script.fetchDepartmentIds({}, ''), /HTTP 503/);
});

test('legacy Gasoline also separates technician rows', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../gasoline.js'), 'utf8');
  const writes = [];
  const context = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getId: () => 'test' }) },
    Sheets: { Spreadsheets: { Values: { batchUpdate: request => writes.push(...request.data) } } },
    gasolineCountStackFormula_: () => '=1', gasolineAmountFormula_: () => '=80'
  });
  vm.runInContext(source.match(/function batchUpsertGasolineDetail_\([\s\S]*?\n}/)[0], context);
  const ctx = { sheet: { getName: () => 'Gasoline' },
    index: { 'BK1__Alice': 2 }, hasFormula: { 2: true }, lastRow: 2 };
  context.batchUpsertGasolineDetail_([{ ticketNo: 'BK1', technician: 'Bob' }], ctx, {}, 'now');
  assert.equal(ctx.index['BK1__Alice'], 2);
  assert.equal(ctx.index['BK1__Bob'], 3);
  assert.equal(writes[0].range, "'Gasoline'!A3:N3");
});

test('HR snapshot keeps old values when the replacement fails', () => {
  let cleared = false;
  const range = {
    breakApart() { return this; }, merge() { return this; }, setValue() { return this; },
    clearContent() { cleared = true; return this; },
    setValues() { throw new Error('write failed'); }
  };
  const sheet = {
    getFilter: () => null, getRange: () => range, getLastRow: () => 3, getMaxRows: () => 1000
  };
  const context = vm.createContext({ SpreadsheetApp: { openById: () => ({
    getSpreadsheetTimeZone: () => 'Asia/Bangkok', getSheetByName: () => sheet
  }) } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../HR/RocketWarningCardSync.js'), 'utf8'), context);
  assert.throws(() => context.wcWriteSnapshot_([], { startDate: '01/09/2026', endDate: '09/09/2026' }), /write failed/);
  assert.equal(cleared, false);
});

test('installation plan accepts Thai and ISO appointment dates', () => {
  const script = loadScript('sync-7day-installation-plan.js');
  for (const text of ['9 ก.ย. 2569 08:00', '2026-09-09 08:00', '09/09/2026 08:00', '09.09.2026 08.00น.']) {
    const parsed = script.parseAppointment(text);
    assert.equal(parsed.dateStr, '09/09/2026');
    assert.equal(parsed.dateObj.getHours(), 8);
  }
});

test('installation plan covers exactly seven days starting tomorrow in Bangkok', () => {
  const script = loadScript('sync-7day-installation-plan.js');
  const range = script.compute7DayPlanRangeBangkok(new Date('2026-09-09T13:30:00Z'));
  assert.equal(range.start, '10/09/2026');
  assert.equal(range.end, '16/09/2026');
});

test('installation plan does not write salesperson value to sheet rows', () => {
  const script = loadScript('sync-7day-installation-plan.js');
  const row = script.itemToRow({
    ticketNo: 'BKIN0926-000098.R02',
    salesperson: 'สุดารัตน์ จุใจ',
    reportDate: '10/09/2026'
  }, '10/09/2026 12:00:00');
  assert.equal(row[0], 'BKIN0926-000098.R02');
  assert.equal(row[1], ''); // Salesperson column is empty
});

test('upgraded SheetJS preserves Thai gasoline exports, ticket text and amounts', () => {
  const XLSX = require('xlsx');
  const script = loadScript('sync-gasoline.js', { xlsx: XLSX });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['รายงานค่าน้ำมัน'], ['01/09/2026 - 09/09/2026'], ['ทีม A'],
    ['วันที่ถึงหน้างาน', 'ใบงาน', 'เลขตั๋ว', 'ลูกค้า', 'ช่าง', 'จำนวน', 'หมายเหตุ'],
    ['09/09/2026', '000123', 'BKRM0926-000001.R01', 'ลูกค้าทดสอบ', 'ช่างหนึ่ง', '1,200', 'ทดสอบ'],
    ['09/09/2026', '000123', 'BKRM0926-000001.R01', 'ลูกค้าทดสอบ', 'ช่างสอง', 0, ''],
    ['', '', '', '', '', '', 'ยอดรวม']
  ]), 'รายงาน');
  for (const bookSST of [true, false]) {
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true, bookSST });
    const rows = script.extractGasolineTeamRows(buffer);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].jobNo, '000123');
    assert.equal(rows[0].ticketNo, 'BKRM0926-000001.R01');
    assert.equal(rows[0].technician, 'ช่างหนึ่ง');
    assert.equal(rows[1].technician, 'ช่างสอง');
    assert.equal(rows[0].team, 'ทีม A');
    assert.equal(rows[0].counted, 1200);
    assert.equal(rows[1].counted, 0);
  }
});

test('upgraded Google client sends authenticated snapshot requests with the expected payload', async () => {
  const { google } = require('googleapis');
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization,
      body: body ? JSON.parse(body) : null });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url.includes('/values/')) {
      res.end(JSON.stringify({ values: [['old header'], ['old row'], ['obsolete row']] }));
    } else if (req.method === 'GET') {
      res.end(JSON.stringify({ sheets: [{ properties: {
        sheetId: 0, gridProperties: { rowCount: 100, columnCount: 36 }
      } }] }));
    } else {
      res.end(JSON.stringify({ totalUpdatedRows: 3 }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: 'offline-test-token' });
    const sheets = google.sheets({ version: 'v4', auth,
      rootUrl: `http://127.0.0.1:${server.address().port}/` });
    await sheetsLib.replaceSheetData(sheets, 'test', 0, 'Jobs', ['ID', 'Name'], [['42', 'Thai text']]);
    assert.ok(requests.every(r => r.authorization === 'Bearer offline-test-token'));
    const writes = requests.filter(r => r.method === 'POST');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].url, '/v4/spreadsheets/test/values:batchUpdate');
    assert.deepEqual(writes[0].body, { valueInputOption: 'USER_ENTERED', data: [{
      range: "'Jobs'!A1:B3", values: [['ID', 'Name'], ['42', 'Thai text'], ['', '']]
    }] });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
