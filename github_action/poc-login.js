const rocket = require('./lib/rocket-client');

async function main() {
  const auth = await rocket.rocketLogin();
  console.log('LOGIN OK');

  // Query getTable for today + 7 days with date_type='2' (appointment)
  // Let's test both date_type='2' and also date_type='1' (to see recent installation tickets)
  const range = {
    start: '01/09/2026',
    end: '12/09/2026'
  };

  console.log('Querying date_type=2 (appointments):', range);
  const tableHtml = await rocket.getParentTicketHtml(auth, range.start, range.end, '2');
  console.log('tableHtml length:', tableHtml.length);

  // Extract all rows from tableHtml
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  let count = 0;
  const sampleRows = [];
  while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
    const rHtml = rowMatch[1];
    if (rHtml.includes('ticket_view.php')) {
      count++;
      if (rHtml.includes('BKIN') || rHtml.includes('IN') || sampleRows.length < 5) {
        sampleRows.push(rHtml);
      }
    }
  }
  console.log('Total data rows in date_type=2:', count);
  console.log('Sample rows found:', sampleRows.length);

  for (let i = 0; i < Math.min(sampleRows.length, 3); i++) {
    console.log('--- SAMPLE ROW ' + (i+1) + ' ---');
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cMatch;
    let colIdx = 0;
    while ((cMatch = cellRegex.exec(sampleRows[i])) !== null) {
      console.log('Col ' + colIdx + ':', rocket.cleanText(cMatch[1]));
      colIdx++;
    }
  }

  // Also query BKIN specifically
  console.log('\n--- Searching BKIN0826-000635 row ---');
  const bkinHtml = await rocket.getParentTicketHtml(auth, '01/08/2026', '12/09/2026', '1', 'BKIN0826-000635');
  let bRowMatch;
  while ((bRowMatch = rowRegex.exec(bkinHtml)) !== null) {
    if (bRowMatch[1].includes('BKIN0826-000635')) {
      console.log('BKIN ROW RAW:', bRowMatch[1]);
      const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let cMatch;
      let colIdx = 0;
      while ((cMatch = cellRegex.exec(bRowMatch[1])) !== null) {
        console.log('Col ' + colIdx + ':', rocket.cleanText(cMatch[1]));
        colIdx++;
      }
    }
  }

  // Also inspect ticket_list.php select options for search_type
  const listRes = await fetch('https://rocket75.com/main/ticket_list.php', {
    headers: { Cookie: auth.cookie }
  });
  const listHtml = await listRes.text();
  const searchTypeMatch = listHtml.match(/<select[^>]*name=["']search_type["'][^>]*>([\s\S]*?)<\/select>/i);
  if (searchTypeMatch) {
    console.log('search_type options:', rocket.cleanText(searchTypeMatch[1]));
  }
  const dateTypeMatch = listHtml.match(/<select[^>]*name=["']date_type["'][^>]*>([\s\S]*?)<\/select>/i);
  if (dateTypeMatch) {
    console.log('date_type options:', rocket.cleanText(dateTypeMatch[1]));
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
