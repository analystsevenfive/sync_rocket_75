const rocket = require('./lib/rocket-client');

async function main() {
  const auth = await rocket.rocketLogin();
  const html = await rocket.getParentTicketHtml(auth, '01/08/2026', '12/09/2026', '1', 'BKIN0826-000736');
  const pMatch = html.match(/ticket_view\.php\?id=(\d+)/i);
  if (!pMatch) {
    console.log('Not found BKIN0826-000736');
    return;
  }
  const parentId = pMatch[1];
  console.log('BKIN0826-000736 Parent ID:', parentId);

  // Check checkrepair
  const crHtml = await rocket.getCheckRepairHtml(parentId, auth);
  console.log('crHtml has รัตนา?:', crHtml.includes('รัตนา'));
  const subIds = rocket.extractCheckRepairIds(crHtml);
  console.log('Sub IDs:', subIds);
  for (const sId of subIds) {
    const sHtml = await rocket.getTicketDetailHtml(sId, auth);
    console.log(`Sub ${sId} has รัตนา?:`, sHtml.includes('รัตนา'));
    if (sHtml.includes('รัตนา')) {
      const idx = sHtml.indexOf('รัตนา');
      console.log(`Sub context:`, sHtml.substring(Math.max(0, idx - 150), idx + 150));
    }
  }

  // Also check parent ticket_view
  const pRes = await fetch('https://rocket75.com/main/ticket_view.php?id=' + parentId, {
    headers: { Cookie: auth.cookie }
  });
  const pHtml = await pRes.text();
  console.log('pHtml has รัตนา?:', pHtml.includes('รัตนา'));
  if (pHtml.includes('รัตนา')) {
    const idx = pHtml.indexOf('รัตนา');
    console.log(`Parent context:`, pHtml.substring(Math.max(0, idx - 150), idx + 150));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
