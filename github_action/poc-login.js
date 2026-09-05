const rocket = require('./lib/rocket-client');

async function main() {
  const auth = await rocket.rocketLogin();

  // Search IN tickets (search_type = '3') with appointment date_type = '2'
  const body = new URLSearchParams();
  body.set('status', '');
  body.set('start_date', '01/09/2026'); // test from start of Sep to today+7
  body.set('end_date', '12/09/2026');
  body.set('search_checkrepair', 'x');
  body.set('name_search', '');
  body.set('search_team', 'x');
  body.set('search_staff', 'x');
  body.set('token', auth.token);
  body.set('key', auth.key);
  body.set('search_type', '3'); // IN = Installation!
  body.set('search_area', 'x');
  body.set('date_type', '2'); // 2 = Appointment
  body.set('search_warranty_type', 'x');

  const res = await fetch('https://rocket75.com/main/ajax/ticket/getTable.php', {
    method: 'POST',
    headers: {
      Origin: 'https://rocket75.com',
      Referer: 'https://rocket75.com/main/ticket_list.php',
      'X-Requested-With': 'XMLHttpRequest',
      Cookie: auth.cookie
    },
    body: body
  });
  const html = await res.text();
  console.log('getTable IN (3) + date_type(2) length:', html.length);
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  let count = 0;
  while ((m = rowRegex.exec(html)) !== null) {
    if (m[1].includes('ticket_view.php')) {
      count++;
      console.log('--- IN ROW ' + count + ' ---');
      const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let cm;
      let colIdx = 0;
      while ((cm = cellRegex.exec(m[1])) !== null) {
        console.log(`Col ${colIdx}: ${rocket.cleanText(cm[1])}`);
        colIdx++;
      }
    }
  }
  console.log('Total IN rows found:', count);
}

main().catch(console.error);
