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
  assert.equal(failures, 3);
  assert.deepEqual(await rocket.mapConcurrentStrict([2, 1], 2, async id => id), [2, 1]);
});

test('gasoline clears sheet before writing, keeps different technicians on separate rows, and deduplicates repeated input', async () => {
  const script = loadScript('sync-gasoline.js');
  const { sheets, state } = fakeSheets();
  let clearedRange = null;
  sheets.spreadsheets.values.clear = async req => {
    clearedRange = req.range;
    state.values = [];
  };
  const ctx = {
    existingReviews: { 'BK1__Alice': 'Approved' },
    existingNotes: { 'BK1__Alice': 'note1' },
    existingAllTechs: { 'BK1': 'Alice, Bob' },
    existingUrls: { 'BK1': 'https://rocket75.com/ticket/1' },
    lastRow: 3
  };
  const rowAlice = { ticketNo: 'BK1', technician: 'Alice', counted: 1, arrivedDate: '01/08/2026', jobNo: 'J1', customer: 'Cust', team: 'A', remarks: '' };
  const rowBob = { ticketNo: 'BK1', technician: 'Bob', counted: 1, arrivedDate: '01/08/2026', jobNo: 'J1', customer: 'Cust', team: 'A', remarks: '' };

  await script.clearAndWriteGasolineRows(sheets, 'test', 0, 'Gasoline Detail', [rowAlice, rowBob, rowBob], ctx, {}, {}, 'now');

  assert.ok(clearedRange && clearedRange.includes('A3:Z'));
  assert.equal(state.writes.length, 1);
  const write = state.writes[0];
  assert.equal(write.range, "'Gasoline Detail'!A3:O4");
  assert.equal(write.values.length, 2); // Alice and Bob (Bob deduplicated)
  assert.equal(write.values[0][2], 'BK1'); // Ticket No
  assert.equal(write.values[0][4], 'Alice'); // Technician
  assert.equal(write.values[0][11], 'Approved'); // Preserved Review
  assert.equal(write.values[0][12], 'note1'); // Preserved Note
  assert.equal(write.values[1][4], 'Bob'); // Technician
  assert.equal(ctx.lastRow, 4);
});

test('gasoline inherits Date Arrived, Customer, and Job No across duplicate/sibling technician rows for the same ticket', async () => {
  const script = loadScript('sync-gasoline.js');
  const { sheets, state } = fakeSheets();
  sheets.spreadsheets.values.clear = async () => { state.values = []; };
  const ctx = {
    existingReviews: {},
    existingNotes: {},
    existingAllTechs: {},
    existingUrls: {},
    existingArrivedDates: {},
    lastRow: 2
  };
  // Row 1 (e.g. from Team A) has empty arrivedDate and generic 'ใบงานเปล่า'
  const rowTeamA = {
    ticketNo: 'BKPM0326-000613.R12',
    technician: 'ช่างเอ',
    counted: 1,
    arrivedDate: '',
    jobNo: 'ใบงานเปล่า',
    customer: 'บจก. กวง',
    team: 'A (BK)',
    remarks: ''
  };
  // Row 2 (e.g. from Team B / หัวหน้าช่าง) has arrivedDate '18/09/2026' and real jobNo '000613'
  const rowTeamB = {
    ticketNo: 'BKPM0326-000613.R12',
    technician: 'ช่างบี',
    counted: 1,
    arrivedDate: '18/09/2026',
    jobNo: '000613',
    customer: 'บจก. กวง',
    team: 'B (BK)',
    remarks: ''
  };

  await script.clearAndWriteGasolineRows(sheets, 'test', 0, 'Gasoline Detail', [rowTeamA, rowTeamB], ctx, {}, {}, 'now');

  assert.equal(state.writes.length, 1);
  const write = state.writes[0];
  assert.equal(write.values.length, 2);
  // Row 1 must inherit 18/09/2026 and 000613
  assert.equal(write.values[0][0], '18/09/2026');
  assert.equal(write.values[0][1], '000613');
  assert.equal(write.values[0][2], 'BKPM0326-000613.R12');
  assert.equal(write.values[0][4], 'ช่างเอ');
  // Row 2 retains 18/09/2026
  assert.equal(write.values[1][0], '18/09/2026');
  assert.equal(write.values[1][1], '000613');
  assert.equal(write.values[1][2], 'BKPM0326-000613.R12');
  assert.equal(write.values[1][4], 'ช่างบี');
});

test('gasoline computeDateRange moves the start date on the 16th and supports year rollover', () => {
  const script = loadScript('sync-gasoline.js');
  // The range start stays unchanged through the 15th and advances on the 16th.
  const oct15 = new Date('2026-10-15T08:00:00+07:00');
  const beforeCutoff = script.computeDateRange('', '', oct15);
  assert.equal(beforeCutoff.start, '16/07/2026');
  assert.equal(beforeCutoff.end, '15/10/2026');

  const oct16 = new Date('2026-10-16T08:00:00+07:00');
  const onCutoff = script.computeDateRange('', '', oct16);
  assert.equal(onCutoff.start, '16/08/2026');
  assert.equal(onCutoff.end, '16/10/2026');

  // Year rollover (Feb): start advances from November to December on the 16th.
  const febDate = new Date('2027-02-15T10:00:00+07:00');
  const febRange = script.computeDateRange('', '', febDate);
  assert.equal(febRange.start, '16/11/2026');
  assert.equal(febRange.end, '15/02/2027');
  const feb16 = new Date('2027-02-16T10:00:00+07:00');
  assert.equal(script.computeDateRange('', '', feb16).start, '16/12/2026');

  // Year rollover (Jan): 15 January 2027 -> 16/10/2026 to 15/01/2027
  const janDate = new Date('2027-01-15T10:00:00+07:00');
  const janRange = script.computeDateRange('', '', janDate);
  assert.equal(janRange.start, '16/10/2026');
  assert.equal(janRange.end, '15/01/2027');

  // Override support
  const overrideRange = script.computeDateRange('01/05/2026', '31/05/2026', oct15);
  assert.equal(overrideRange.start, '01/05/2026');
  assert.equal(overrideRange.end, '31/05/2026');
});

test('yesterday computeTargetDateRange defaults to yesterday and supports manual date overrides', () => {
  const script = loadScript('sync-yesterday-jobs.js');
  const baseDate = new Date('2026-09-18T10:00:00+07:00');

  // Default: yesterday (17/09/2026)
  const defaultRange = script.computeTargetDateRange('', baseDate);
  assert.equal(defaultRange.start, '17/09/2026');
  assert.equal(defaultRange.end, '17/09/2026');
  assert.equal(defaultRange.isOverride, false);

  // Override with full DD/MM/YYYY
  const manualRange = script.computeTargetDateRange('15/09/2026', baseDate);
  assert.equal(manualRange.start, '15/09/2026');
  assert.equal(manualRange.end, '15/09/2026');
  assert.equal(manualRange.isOverride, true);

  // Override with short D/M (e.g. 5/8 -> 05/08/2026)
  const shortRange = script.computeTargetDateRange('5/8', baseDate);
  assert.equal(shortRange.start, '05/08/2026');
  assert.equal(shortRange.end, '05/08/2026');
  assert.equal(shortRange.isOverride, true);

  // Override with ISO format YYYY-MM-DD
  const isoRange = script.computeTargetDateRange('2026-09-10', baseDate);
  assert.equal(isoRange.start, '10/09/2026');
  assert.equal(isoRange.end, '10/09/2026');
  assert.equal(isoRange.isOverride, true);

  // Invalid date format throws
  assert.throws(() => script.computeTargetDateRange('invalid-date', baseDate), /รูปแบบวันที่ไม่ถูกต้อง/);
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
  const watchdog = setTimeout(() => server.closeAllConnections(), 1000);
  try {
    const res = await rocket.fetchWithTimeout(`http://127.0.0.1:${server.address().port}`, {}, 150);
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
  script.fetchOrgChartPage = async () => '<select><option value="75">75 - Company</option><option value="BK">BK - Other</option></select>';
  script.fetchOrgChartTableAjax = async () => '';
  script.fetchDepartmentIds = async () => [];
  await assert.rejects(script.main(), /No employees parsed|No companies discovered/);
});

test('employee sync can write the primary organization table without department discovery', async () => {
  let writtenRows;
  const script = loadScript('sync-employee.js', {
    './lib/rocket-client': {
      rocketLogin: async () => ({}),
      formatDateTimeBangkok: () => 'now',
      cleanText: value => value
    },
    './lib/sheets-client': {
      getSheetsClient: async () => ({}),
      ensureSheetExists: async () => 1,
      replaceSheetData: async (sheets, id, sheetId, name, headers, rows) => {
        writtenRows = { headers, rows };
      }
    }
  });
  script.fetchOrgChartPage = async () => '<select><option value="75">75 - Company</option><option value="BK">BK - Other</option></select>';
  script.fetchOrgChartTableAjax = async () => '<div>employee table</div>';
  script.extractEmployeesFromHtml = () => [{
    company: '75 - Company', department: '', team: '', position: 'Staff',
    level: 'L.3', employeeId: '0100001', fullName: 'Test User'
  }];
  await script.main();
  assert.equal(writtenRows.rows.length, 1);
  assert.equal(writtenRows.rows[0][1], '');
  assert.equal(writtenRows.rows[0][2], '');
});

test('employee sync collects every company before replacing the sheet', async () => {
  let writtenRows;
  const script = loadScript('sync-employee.js', {
    './lib/rocket-client': { rocketLogin: async () => ({}), formatDateTimeBangkok: () => 'now', cleanText: value => value },
    './lib/sheets-client': {
      getSheetsClient: async () => ({}), ensureSheetExists: async () => 1,
      replaceSheetData: async (sheets, id, sheetId, name, headers, rows) => { writtenRows = rows; }
    }
  });
  script.fetchOrgChartPage = async () => '<select name="hr_company"><option value="75">75 - Company A</option>' +
    '<option value="BK">BK - Company B</option><option value="NTS">NTS - Company C</option></select>';
  const requested = [];
  script.fetchOrgChartPage = async (auth, companyId) => {
    requested.push('page:' + (companyId || 'initial'));
    return '<select name="hr_company"><option value="75">75 - Company A</option>' +
      '<option value="BK">BK - Company B</option><option value="NTS">NTS - Company C</option></select>';
  };
  script.fetchOrgChartTableAjax = async (auth, departmentId, companyId) => {
    requested.push('table:' + companyId);
    return '<table>rows for ' + companyId + '</table>';
  };
  script.extractEmployeesFromHtml = (html, context) => [{
    company: context.company, department: '', team: '', position: 'Staff', level: 'L.3',
    employeeId: context.company.slice(0, 2) + '00001', fullName: context.company
  }];
  await script.main();
  assert.deepEqual(requested, [
    'page:initial', 'page:75', 'table:75', 'page:BK', 'table:BK', 'page:NTS', 'table:NTS'
  ]);
  assert.deepEqual(Array.from(writtenRows, row => row[0]), [
    '75 - Company A', 'BK - Company B', 'NTS - Company C'
  ]);
});

test('employee organization context keeps the selected department and manager group head', () => {
  const script = loadScript('sync-employee.js');
  const employees = [
    { position: 'กรรมการบริหาร', level: 'L.11', employeeId: '0100001', fullName: 'Exec One' },
    { position: 'ผู้จัดการแผนกบัญชี', level: 'L.8', employeeId: '0100002', fullName: 'Manager One' },
    { position: 'เจ้าหน้าที่บัญชี', level: 'L.4', employeeId: '0100003', fullName: 'Staff One' }
  ];
  const result = script.applyOrgContext(employees, {
    company: '75 - Company', department: 'บัญชี'
  });

  assert.equal(result[0].department, 'บัญชี');
  assert.equal(result[0].team, '');
  assert.equal(result[1].department, 'บัญชี');
  assert.match(result[1].team, /0100002/);
  assert.equal(result[2].department, 'บัญชี');
  assert.match(result[2].team, /0100002/);
  assert.equal(result[2].company, '75 - Company');
});

test('employee department comes from management position and team follows source hierarchy', () => {
  const script = loadScript('sync-employee.js');
  const sourceOrder = [
    { position: 'กรรมการบริหาร', level: 'L.11', employeeId: '0107075', fullName: 'Executive' },
    { position: 'หัวหน้าประสานงานขาย', level: 'L.6', employeeId: '0122012', fullName: 'Sales Lead' },
    { position: 'เจ้าหน้าที่ขายอาวุโส', level: 'L.4', employeeId: '0107018', fullName: 'Sales Staff' },
    { position: 'ผู้จัดการแผนกบัญชี', level: 'L.8', employeeId: '0117065', fullName: 'Accounting Manager' },
    { position: 'เจ้าหน้าที่บัญชีทรัพย์สิน', level: 'L.4', employeeId: '0107033', fullName: 'Accounting Staff' }
  ];
  const result = script.applyTeamHierarchy(script.applyOrgContext(sourceOrder, {}));
  assert.equal(result[1].team, 'หัวหน้าประสานงานขาย - Sales Lead - 0122012');
  assert.equal(result[2].team, 'หัวหน้าประสานงานขาย - Sales Lead - 0122012');
  assert.equal(result[3].department, 'บัญชี');
  assert.equal(result[4].department, 'บัญชี');
  assert.equal(result[4].team, 'ผู้จัดการแผนกบัญชี - Accounting Manager - 0117065');
  assert.equal(script.inferDepartmentFromPosition('ผู้จัดการแผนกบัญชี'), 'บัญชี');
  assert.equal(script.inferDepartmentFromPosition('หัวหน้าประสานงานขาย'), 'การตลาด');
  assert.equal(script.inferDepartmentFromPosition('หัวหน้าช่างเทคนิค ทีม B'), 'ช่างเทคนิค');
});

test('employee sync maps sales to marketing and links executive assistants to the named director', () => {
  const script = loadScript('sync-employee.js');
  const employees = [
    { position: 'กรรมการบริหาร คุณอรุณี ตั้งกมลสุข', level: 'L.11', employeeId: '0107088', fullName: 'อรุณี ตั้งกมลสุข' },
    { position: 'ผู้ช่วยผู้บริหาร (คุณอรุณี)', level: 'L.8', employeeId: '0114034', fullName: 'กรลักษณ์ สาสงวน' },
    { position: 'หัวหน้าประสานงานขาย', level: 'L.6', employeeId: '0122012', fullName: 'ณฐกร เย็นวัฒนากุล' },
    { position: 'เจ้าหน้าที่ขายอาวุโส', level: 'L.4', employeeId: '0107018', fullName: 'ฉัฐชนก แสนยศ' }
  ];
  const result = script.applyTeamHierarchy(script.applyOrgContext(employees, {}));
  assert.equal(result[1].team, 'กรรมการบริหาร คุณอรุณี ตั้งกมลสุข - อรุณี ตั้งกมลสุข - 0107088');
  assert.equal(result[2].department, 'การตลาด');
  assert.equal(result[3].department, 'การตลาด');
  assert.equal(result[3].team, 'หัวหน้าประสานงานขาย - ณฐกร เย็นวัฒนากุล - 0122012');
});

test('employee company filter is found by id or by company option pattern', () => {
  const script = loadScript('sync-employee.js');
  const byId = '<select id="hr_company"><option value="x">ทั้งหมด</option>' +
    '<option value="75" selected>75 - เซเว่นไฟว์ ดิสทริบิวเตอร์</option></select>';
  assert.equal(script.extractCompanyText(byId), '75 - เซเว่นไฟว์ ดิสทริบิวเตอร์');
  assert.equal(script.extractCompanySelection(byId).value, '75');

  const byOptions = '<select class="form-control"><option value="x">ทั้งหมด</option>' +
    '<option value="75">75 - เซเว่นไฟว์ ดิสทริบิวเตอร์</option>' +
    '<option value="BK">BK - บางกอก เซเว่นไฟว์</option></select>';
  assert.equal(script.extractCompanyText(byOptions), '75 - เซเว่นไฟว์ ดิสทริบิวเตอร์');
});

test('employee departments fall back to the select following the company filter', async () => {
  const script = loadScript('sync-employee.js', {
    './lib/rocket-client': {
      cleanText: rocket.cleanText,
      fetchWithTimeout: async () => new Response('', { status: 404 })
    }
  });
  const html = '<select class="generated"><option value="75">75 - Company</option>' +
    '<option value="BK">BK - Company</option></select>' +
    '<select class="generated"><option value="x">ทั้งหมด</option>' +
    '<option value="10">การตลาด</option><option value="20">บัญชี</option></select>';
  const departments = await script.fetchDepartmentIds({}, html, '75');
  assert.equal(JSON.stringify(departments), JSON.stringify([
    { id: '10', name: 'การตลาด' }, { id: '20', name: 'บัญชี' }
  ]));
});

test('duplicate employee rows do not overwrite an established organization path', () => {
  const script = loadScript('sync-employee.js');
  const first = { employeeId: '0100003', company: '75', department: 'Exec A', team: 'Manager A' };
  const duplicate = { employeeId: '0100003', company: '', department: 'Exec B', team: 'Manager B', desk: '101' };
  const merged = script.mergeEmployee(first, duplicate);
  assert.equal(merged.department, 'Exec A');
  assert.equal(merged.team, 'Manager A');
  assert.equal(merged.desk, '101');
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

test('installation plan supports start and end date overrides', () => {
  const script = loadScript('sync-7day-installation-plan.js');
  const range = script.compute7DayPlanRangeBangkok(new Date('2026-09-09T13:30:00Z'), '01/09/2026', '05/09/2026');
  assert.equal(range.start, '01/09/2026');
  assert.equal(range.end, '05/09/2026');
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

test('Tomorrow Plan, Yesterday Jobs, and Daily Repair include Product Code column before Product Name', () => {
  const scripts = [
    { name: 'sync-tomorrow-plan.js', toRowFn: 'planToRow' },
    { name: 'sync-yesterday-jobs.js', toRowFn: 'jobToRow' },
    { name: 'sync-daily-repair.js', toRowFn: 'jobToRow' }
  ];

  for (const { name, toRowFn } of scripts) {
    const file = path.join(__dirname, '..', name);
    const scriptContent = fs.readFileSync(file, 'utf8');

    // Extract headers array from source
    const headerMatch = scriptContent.match(/const\s+(?:PLAN_)?HEADERS\s*=\s*\[([\s\S]*?)\];/);
    assert.ok(headerMatch, `${name} has HEADERS definition`);
    const headers = eval(`[${headerMatch[1]}]`);

    const codeIdx = headers.indexOf('Product Code');
    const nameIdx = headers.indexOf('Product Name');
    assert.ok(codeIdx !== -1, `${name} must include 'Product Code' header`);
    assert.ok(nameIdx !== -1, `${name} must include 'Product Name' header`);
    assert.equal(codeIdx, nameIdx - 1, `'Product Code' must be right before 'Product Name' in ${name}`);

    // Test row mapping alignment
    const script = loadScript(name);
    const sampleTicket = {
      ticketId: '100',
      ticketNo: 'BK100',
      productCode: 'NTS1-EWB-24',
      productName: 'Sample Product'
    };
    const row = script[toRowFn](sampleTicket, '2026-09-16 08:00:00');
    assert.equal(row.length, headers.length, `Row column count (${row.length}) must match headers length (${headers.length}) in ${name}`);
    assert.equal(row[codeIdx], 'NTS1-EWB-24', `Row must have productCode at index ${codeIdx}`);
    assert.equal(row[nameIdx], 'Sample Product', `Row must have productName at index ${nameIdx}`);
  }
});

test('Daily Repair includes Status 1, Status 2, and Status 3 columns right after Active Stage', () => {
  const file = path.join(__dirname, '..', 'sync-daily-repair.js');
  const scriptContent = fs.readFileSync(file, 'utf8');

  const headerMatch = scriptContent.match(/const\s+HEADERS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(headerMatch, 'sync-daily-repair.js has HEADERS definition');
  const headers = eval(`[${headerMatch[1]}]`);

  const activeStageIdx = headers.indexOf('Active Stage');
  const status1Idx = headers.indexOf('Status 1');
  const status2Idx = headers.indexOf('Status 2');
  const status3Idx = headers.indexOf('Status 3');
  const salesInvoiceIdx = headers.indexOf('Sales Invoice No.');

  assert.ok(activeStageIdx !== -1, "headers must include 'Active Stage'");
  assert.equal(status1Idx, activeStageIdx + 1, "'Status 1' must be right after 'Active Stage'");
  assert.equal(status2Idx, status1Idx + 1, "'Status 2' must be right after 'Status 1'");
  assert.equal(status3Idx, status2Idx + 1, "'Status 3' must be right after 'Status 2'");
  assert.equal(salesInvoiceIdx, status3Idx + 1, "'Sales Invoice No.' must be right after 'Status 3'");

  const script = loadScript('sync-daily-repair.js');
  const sampleTicket = {
    ticketId: '100',
    ticketNo: 'BK100.R01',
    activeStage: 'งานจบ',
    status1: 'รอเข้างาน',
    status2: 'กำลังซ่อม',
    status3: 'ซ่อมเสร็จแล้ว, ตรวจงานแล้ว, รอเปิดบิล',
    salesInvoiceNo: 'IV12345'
  };
  const row = script.jobToRow(sampleTicket, '2026-09-16 08:00:00');
  assert.equal(row.length, headers.length, `Row column count (${row.length}) must match headers length (${headers.length})`);
  assert.equal(row[status1Idx], 'รอเข้างาน');
  assert.equal(row[status2Idx], 'กำลังซ่อม');
  assert.equal(row[status3Idx], 'ซ่อมเสร็จแล้ว, ตรวจงานแล้ว, รอเปิดบิล');

  // Test extractCheckRepairInfo extracts Status 2 (cells[3])
  const sampleCheckRepairHtml = `
    <table>
      <tr>
        <td>BKRM0926-000346.R01<br>งานซ่อม</td>
        <td>ทีม : A (BK)<br>นัดหมาย : 16/09/2026 11:00</td>
        <td>ชรรศ ก้อนทอง ทีม A (BK)</td>
        <td><button class="btn btn-sm btn-primary">กำลังซ่อม</button></td>
        <td><a href="ticket_checkrepair_view.php?id=1922649850" class="btn btn-sm btn-icon"><i class="fa fa-eye"></i></a></td>
      </tr>
    </table>
  `;
  const infoMap = rocket.extractCheckRepairInfo(sampleCheckRepairHtml);
  assert.ok(infoMap['1922649850'], 'must find sub-ticket info by subId');
  assert.equal(infoMap['1922649850'].status, 'กำลังซ่อม');
  assert.equal(infoMap['BKRM0926-000346.R01'].status, 'กำลังซ่อม');
  assert.equal(infoMap['1922649850'].team, 'A (BK)');
  assert.equal(infoMap['1922649850'].technicians, 'ชรรศ ก้อนทอง');

  // Test extractParentToStatusesMap
  const sampleTableHtml = `
    <table>
      <tr>
        <td><a href="ticket_view.php?id=3098718035">BKRM0926-000350</a></td>
        <td>Creator</td>
        <td>Customer</td>
        <td>Machine</td>
        <td>
          <span class="badge badge-success">ซ่อมเสร็จแล้ว</span>
          <span class="badge badge-success">ตรวจงานแล้ว</span>
          <span class="badge badge-primary">รอเปิดบิล</span>
        </td>
      </tr>
      <tr>
        <td><a href="ticket_view.php?id=3098718049">BKRM0926-000349</a></td>
        <td>Creator</td>
        <td>Customer</td>
        <td>Machine</td>
        <td>
          <span class="badge badge-info">รอเข้าซ่อม</span>
        </td>
      </tr>
    </table>
  `;
  const statusMap = script.extractParentToStatusesMap(sampleTableHtml);
  assert.deepEqual([...statusMap['3098718035']], ['ซ่อมเสร็จแล้ว', 'ตรวจงานแล้ว', 'รอเปิดบิล']);
  assert.deepEqual([...statusMap['BKRM0926-000350']], ['ซ่อมเสร็จแล้ว', 'ตรวจงานแล้ว', 'รอเปิดบิล']);
  assert.deepEqual([...statusMap['3098718049']], ['รอเข้าซ่อม']);
});

test('parseTicketDetail extracts real status (e.g. รอเข้างาน) and ignores user profile Active badge', () => {
  const samplePageHtml = `
    <!DOCTYPE html>
    <html>
      <body>
        <!-- Top Navbar with User Profile Status -->
        <div class="d-flex align-items-center mb-1">
          <a href="#" class="text-gray-800">Admin User</a>
          <span class="badge badge-light-success">Active</span>
        </div>

        <!-- Breadcrumb -->
        <h1>SMRM0926-000342.R01</h1>
        <ul class="breadcrumb">
          <li>หน้าหลัก</li>
          <li>รายการ Ticket</li>
          <li><a href="ticket_view.php?id=0422663501">SMRM0926-000342</a></li>
          <li>SMRM0926-000342.R01</li>
        </ul>

        <!-- Ticket Card Header -->
        <div class="card">
          <div class="d-flex align-items-center mb-1">
            <div class="fs-2 fw-bold">สมุย เซเว่นไฟว์ - บจก.สมุย เซเว่นไฟว์</div>
            <span class="badge badge-light-primary ms-2">รอเข้างาน</span>
          </div>
          <div class="card-body">
            <h5>เวลานัดหมาย</h5>
            <p>16 Sep 2026 08:00</p>
          </div>
        </div>
      </body>
    </html>
  `;

  const parsed = rocket.parseTicketDetail(samplePageHtml, '0422663501');
  assert.equal(parsed.ticketNo, 'SMRM0926-000342.R01');
  assert.equal(parsed.status, 'รอเข้างาน');
  assert.equal(rocket.extractTicketStatus(samplePageHtml), 'รอเข้างาน');
});

test('isBkTicket validates tickets starting with BK', () => {
  assert.equal(rocket.isBkTicket('BKRM0926-000346.R01'), true);
  assert.equal(rocket.isBkTicket('bkrm0926-000346.R01'), true);
  assert.equal(rocket.isBkTicket('BK100'), true);
  assert.equal(rocket.isBkTicket('  BK-999  '), true);
  assert.equal(rocket.isBkTicket('SMRM0926-000342.R01'), false);
  assert.equal(rocket.isBkTicket('PKRM0926-000123'), false);
  assert.equal(rocket.isBkTicket('PTRM0926-000123'), false);
  assert.equal(rocket.isBkTicket('CMRM0926-000123'), false);
  assert.equal(rocket.isBkTicket(''), false);
  assert.equal(rocket.isBkTicket('   '), false);
  assert.equal(rocket.isBkTicket(null), false);
  assert.equal(rocket.isBkTicket(undefined), false);
  assert.equal(rocket.isBkTicket('-'), false);
});

test("hasValidTechnician validates assigned technicians and excludes '-', null, empty", () => {
  assert.equal(rocket.hasValidTechnician('ชรรศ ก้อนทอง'), true);
  assert.equal(rocket.hasValidTechnician('ชรรศ ก้อนทอง, ธนพล'), true);
  assert.equal(rocket.hasValidTechnician('A (BK)'), true);
  assert.equal(rocket.hasValidTechnician('-'), false);
  assert.equal(rocket.hasValidTechnician(' - '), false);
  assert.equal(rocket.hasValidTechnician('--'), false);
  assert.equal(rocket.hasValidTechnician('- , -'), false);
  assert.equal(rocket.hasValidTechnician('–'), false);
  assert.equal(rocket.hasValidTechnician('—'), false);
  assert.equal(rocket.hasValidTechnician('null'), false);
  assert.equal(rocket.hasValidTechnician('NULL'), false);
  assert.equal(rocket.hasValidTechnician('None'), false);
  assert.equal(rocket.hasValidTechnician(''), false);
  assert.equal(rocket.hasValidTechnician('   '), false);
  assert.equal(rocket.hasValidTechnician(null), false);
  assert.equal(rocket.hasValidTechnician(undefined), false);
});

for (const scriptName of ['sync-tomorrow-plan.js', 'sync-yesterday-jobs.js', 'sync-daily-repair.js']) {
  test(`${scriptName} filters tickets where ticketNo starts with BK and technician is not '-' or null`, async () => {
    let writtenRows = null;
    const targetDate = scriptName.includes('tomorrow')
      ? rocket.computeTomorrowRangeBangkok().start
      : (scriptName.includes('yesterday')
        ? rocket.computeYesterdayRangeBangkok().start
        : rocket.computeTodayRangeBangkok().start);

    const script = loadScript(scriptName, {
      './lib/rocket-client': {
        ...rocket,
        rocketLogin: async () => ({ cookie: 'mock' }),
        getParentTicketHtml: async () => '<tr><td><a href="ticket_view.php?id=10">BK1</a></td></tr>',
        extractParentTicketIds: () => ['10'],
        extractParentToCustomerCodeMap: () => ({ '10': 'CUST1' }),
        extractParentToProductIdMap: () => ({ '10': 'PROD1' }),
        getCheckRepairHtml: async () => '',
        extractCheckRepairIds: () => ['101', '102', '103', '104', '105'],
        extractCheckRepairInfo: () => ({
          '101': { ticketNo: 'BKRM01.R01', technicians: 'ช่างหนึ่ง', team: 'A' },
          '102': { ticketNo: 'BKRM02.R01', technicians: '-', team: 'A' },
          '103': { ticketNo: 'BKRM03.R01', technicians: '', team: 'A' },
          '104': { ticketNo: 'SMRM01.R01', technicians: 'ช่างสมุย', team: 'B' },
          '105': { ticketNo: 'BKRM05.R01', technicians: 'null', team: 'A' }
        }),
        getTicketDetailHtml: async (subId) => `<div>ticket ${subId}</div>`,
        parseTicketDetail: (html, subId) => {
          const map = {
            '101': { ticketId: '101', ticketNo: 'BKRM01.R01', appointment: `${targetDate} 09:00`, status: 'กำลังทำ', technician: 'ช่างหนึ่ง' },
            '102': { ticketId: '102', ticketNo: 'BKRM02.R01', appointment: `${targetDate} 10:00`, status: 'กำลังทำ', technician: '-' },
            '103': { ticketId: '103', ticketNo: 'BKRM03.R01', appointment: `${targetDate} 11:00`, status: 'กำลังทำ', technician: '' },
            '104': { ticketId: '104', ticketNo: 'SMRM01.R01', appointment: `${targetDate} 12:00`, status: 'กำลังทำ', technician: 'ช่างสมุย' },
            '105': { ticketId: '105', ticketNo: 'BKRM05.R01', appointment: `${targetDate} 13:00`, status: 'กำลังทำ', technician: 'null' }
          };
          return map[subId];
        },
        getInspectorModalHtml: async () => '',
        parseInspectorModal: () => ({ status: 'ตรวจแล้ว', type: 'งานซ่อม' }),
        getParentPageHtml: async () => '',
        parseCurrentJobType: () => '',
        extractTicketStatus: () => '',
        getModalProductHtml: async () => '',
        parseSalesInvoiceNo: () => ''
      },
      './lib/sheets-client': {
        getSheetsClient: async () => ({}),
        ensureSheetExists: async () => 1,
        replaceSheetData: async (sheets, spreadsheetId, sheetId, sheetName, headers, rows) => {
          writtenRows = rows;
        }
      }
    });

    await script.main();

    assert.ok(writtenRows, 'replaceSheetData must be called');
    assert.equal(writtenRows.length, 1, `Expected exactly 1 row after filtering, got ${writtenRows.length}`);
    assert.equal(writtenRows[0][1], 'BKRM01.R01', 'Written row ticketNo must be BKRM01.R01');
  });
}



test('gasoline URL never falls back to a sibling sub-ticket link via the parent ticket', async () => {
  const script = loadScript('sync-gasoline.js');
  const { sheets, state } = fakeSheets();
  sheets.spreadsheets.values.clear = async () => { state.values = []; };
  const r01Url = 'https://rocket75.com/main/ticket_checkrepair_view.php?id=111';
  const ctx = {
    existingReviews: {}, existingNotes: {}, existingAllTechs: {},
    existingUrls: { 'BKRM0926-000699.R01': r01Url },
    existingArrivedDates: {}, lastRow: 2
  };
  // urlMap มี entry ของ parent ที่ชี้ไป .R01 (จาก getTicketNoToUrlMap)
  const urlMap = { 'BKRM0926-000699.R01': r01Url, 'BKRM0926-000699': r01Url };
  const row = { ticketNo: 'BKRM0926-000699.R02', technician: 'A', counted: 1, arrivedDate: '28/10/2026', jobNo: '', customer: 'C', team: 'B', remarks: '' };

  await script.clearAndWriteGasolineRows(sheets, 'test', 0, 'Gasoline Detail', [row], ctx, urlMap, {}, 'now');

  assert.equal(state.writes[0].values[0][10], '');
});

test('gasoline drops existing URLs shared by sibling sub-tickets so they are re-resolved', async () => {
  const script = loadScript('sync-gasoline.js');
  const { sheets, state } = fakeSheets();
  const url = 'https://rocket75.com/main/ticket_checkrepair_view.php?id=111';
  const ownUrl = 'https://rocket75.com/main/ticket_checkrepair_view.php?id=222';
  state.values = [
    ['28/10/2026', '', 'BKRM0926-000699.R01', 'C', 'A', '', '', 1, '', '', url],
    ['28/10/2026', '', 'BKRM0926-000699.R02', 'C', 'A', '', '', 1, '', '', url],
    ['28/10/2026', '', 'BKRM0926-000699.R02', 'C', 'B', '', '', 1, '', '', url],
    ['28/10/2026', '', 'BKRM1026-000442.R02', 'C', 'A', '', '', 1, '', '', ownUrl],
    ['28/10/2026', '', 'BKRM1026-000442.R02', 'C', 'B', '', '', 1, '', '', ownUrl]
  ];

  const ctx = await script.buildRowIndex(sheets, 'test', 'Gasoline Detail', 0, { start: 's', end: 'e' }, 5);

  assert.equal(ctx.existingUrls['BKRM0926-000699.R01'], undefined);
  assert.equal(ctx.existingUrls['BKRM0926-000699.R02'], undefined);
  assert.equal(ctx.existingUrls['BKRM1026-000442.R02'], ownUrl);
});
