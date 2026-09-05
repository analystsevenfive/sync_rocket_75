const rocket = require('./lib/rocket-client');

async function main() {
  const auth = await rocket.rocketLogin();
  console.log('LOGIN OK');

  const tickets = ['BKIN0826-000581', 'BKIN0826-000608', 'BKIN0826-000757', 'BKIN0826-000736'];
  for (const t of tickets) {
    const html = await rocket.getParentTicketHtml(auth, '01/08/2026', '12/09/2026', '1', t);
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let m;
    while ((m = rowRegex.exec(html)) !== null) {
      if (m[1].includes(t)) {
        const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        let cMatch;
        const cells = [];
        while ((cMatch = cellRegex.exec(m[1])) !== null) {
          cells.push(rocket.cleanText(cMatch[1]));
        }
        console.log(`[${t}] Col0: ${cells[0]} | Col1: ${cells[1]} | Col3: ${cells[3]}`);
      }
    }
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
