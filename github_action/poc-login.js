const sheetsLib = require('./lib/sheets-client');

async function main() {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  console.log('SPREADSHEET_ID:', spreadsheetId);
  const sheets = await sheetsLib.getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  console.log('Spreadsheet Title:', meta.data.properties.title);
  console.log('=== ALL SHEETS ===');
  for (const s of meta.data.sheets) {
    console.log(`- "${s.properties.title}" (id: ${s.properties.sheetId}, rows: ${s.properties.gridProperties.rowCount}, cols: ${s.properties.gridProperties.columnCount})`);
  }

  // Check if any sheet has "Installation" or "ติดตั้ง" or "7-Day"
  for (const s of meta.data.sheets) {
    const title = s.properties.title;
    if (title.includes('Install') || title.includes('ติดตั้ง') || title.includes('7-Day') || title.includes('Plan')) {
      console.log(`\n=== INSPECTING SHEET: "${title}" ===`);
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${title}'!A1:Z5`
      });
      console.log('Rows:', JSON.stringify(res.data.values, null, 2));
    }
  }
}

main().catch(console.error);
