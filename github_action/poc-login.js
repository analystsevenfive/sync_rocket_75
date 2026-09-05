const rocket = require('./lib/rocket-client');

async function main() {
  const auth = await rocket.rocketLogin();
  const parentId = '0115227884'; // BKIN0826-000757

  const tabs = [
    'callcenter.php',
    'administration.php',
    'quotation.php',
    'back_quotation.php',
    'daily_work.php',
    'finance.php',
    'manager.php'
  ];

  for (const tab of tabs) {
    const body = new URLSearchParams();
    body.set('ticket_id', parentId);
    body.set('token', auth.token);
    body.set('key', auth.key);

    const res = await fetch(`https://rocket75.com/main/ajax/ticket_view/${tab}`, {
      method: 'POST',
      headers: {
        Origin: 'https://rocket75.com',
        Referer: 'https://rocket75.com/main/ticket_view.php?id=' + parentId,
        'X-Requested-With': 'XMLHttpRequest',
        Cookie: auth.cookie
      },
      body: body
    });
    const html = await res.text();
    console.log(`Tab ${tab}: len=${html.length}, has แววดาว?=${html.includes('แววดาว')}`);
    if (html.includes('แววดาว')) {
      const idx = html.indexOf('แววดาว');
      console.log(`Context in ${tab}:`, html.substring(Math.max(0, idx - 150), idx + 150));
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
