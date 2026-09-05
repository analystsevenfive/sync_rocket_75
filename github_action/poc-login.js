const rocket = require('./lib/rocket-client');

async function main() {
  const auth = await rocket.rocketLogin();
  console.log('LOGIN OK');

  // Search for BKIN0826-000757
  const html = await rocket.getParentTicketHtml(auth, '01/08/2026', '12/09/2026', '1', 'BKIN0826-000757');
  const pMatch = html.match(/ticket_view\.php\?id=(\d+)/i);
  if (!pMatch) {
    console.log('Parent not found for BKIN0826-000757');
    return;
  }
  const parentId = pMatch[1];
  console.log('Parent ID:', parentId);

  // Check parent HTML
  const pRes = await fetch('https://rocket75.com/main/ticket_view.php?id=' + parentId, {
    headers: { Cookie: auth.cookie }
  });
  const pHtml = await pRes.text();
  console.log('Parent HTML has แววดาว?:', pHtml.includes('แววดาว'));
  if (pHtml.includes('แววดาว')) {
    const idx = pHtml.indexOf('แววดาว');
    console.log('Parent context:', pHtml.substring(Math.max(0, idx - 150), idx + 150));
  }

  // Check checkrepair
  const crHtml = await rocket.getCheckRepairHtml(parentId, auth);
  console.log('Checkrepair HTML has แววดาว?:', crHtml.includes('แววดาว'));
  if (crHtml.includes('แววดาว')) {
    const idx = crHtml.indexOf('แววดาว');
    console.log('Checkrepair context:', crHtml.substring(Math.max(0, idx - 150), idx + 150));
  }

  // Check sub-ticket detail
  const subIds = rocket.extractCheckRepairIds(crHtml);
  for (const sId of subIds) {
    const sRes = await fetch('https://rocket75.com/main/ticket_checkrepair_view.php?id=' + sId, {
      headers: { Cookie: auth.cookie }
    });
    const sHtml = await sRes.text();
    console.log(`Sub ${sId} has แววดาว?:`, sHtml.includes('แววดาว'));
    if (sHtml.includes('แววดาว')) {
      const idx = sHtml.indexOf('แววดาว');
      console.log('Sub context:', sHtml.substring(Math.max(0, idx - 150), idx + 150));
    }
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
