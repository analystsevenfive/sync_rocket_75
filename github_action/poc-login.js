const sheetsLib = require('./lib/sheets-client');

async function main() {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const sheets = await sheetsLib.getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId,
    range: "'7-Day Installation Plan'!A1:O10"
  });
  console.log('=== 7-DAY INSTALLATION PLAN ROWS ===');
  for (let i = 0; i < (res.data.values || []).length; i++) {
    console.log(`Row ${i + 1}:`, JSON.stringify(res.data.values[i]));
  }
}

main().catch(console.error);
