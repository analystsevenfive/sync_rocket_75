const rocket = require('./lib/rocket-client');

async function main() {
  const auth = await rocket.rocketLogin();
  const parentId = '6989878952'; // BKIN0826-000736

  const body = new URLSearchParams();
  body.set('ticket_id', parentId);
  body.set('token', auth.token);
  body.set('key', auth.key);

  const res = await fetch('https://rocket75.com/main/ajax/ticket_view/overview.php', {
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
  console.log('overview for 6989878952 has รัตนา?:', html.includes('รัตนา'));
  if (html.includes('รัตนา')) {
    const idx = html.indexOf('รัตนา');
    console.log('Context:', html.substring(Math.max(0, idx - 150), idx + 150));
  } else {
    console.log('Clean overview text:', rocket.cleanText(html).substring(0, 1500));
  }
}

main().catch(console.error);
