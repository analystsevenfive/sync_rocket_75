const rocket = require('./lib/rocket-client');

async function main() {
  const auth = await rocket.rocketLogin();
  console.log('LOGIN OK');

  // Search name_search = 'แววดาว'
  const html = await rocket.getParentTicketHtml(auth, '01/08/2026', '12/09/2026', '1', 'แววดาว');
  console.log('Search "แววดาว" table length:', html.length);
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  let count = 0;
  while ((m = rowRegex.exec(html)) !== null) {
    if (m[1].includes('ticket_view.php')) {
      count++;
      console.log('Row ' + count + ':', rocket.cleanText(m[1]).substring(0, 300));
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
