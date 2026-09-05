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
  const idx = html.indexOf('begin::Timeline');
  if (idx !== -1) {
    console.log('Timeline HTML:', html.substring(idx, idx + 1500));
  }
}

main().catch(console.error);
