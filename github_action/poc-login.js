const rocket = require('./lib/rocket-client');

async function main() {
  const auth = await rocket.rocketLogin();
  console.log('LOGIN OK');

  // Fetch ticket_view.php?id=7634722708
  const res = await fetch('https://rocket75.com/main/ticket_view.php?id=7634722708', {
    headers: { Cookie: auth.cookie }
  });
  const html = await res.text();
  console.log('ticket_view length:', html.length);

  // Search for BK_SERVICE
  console.log('Contains BK_SERVICE?:', html.includes('BK_SERVICE'));
  if (html.includes('BK_SERVICE')) {
    const idx = html.indexOf('BK_SERVICE');
    console.log('Context of BK_SERVICE:', html.substring(Math.max(0, idx - 200), idx + 200));
  }

  // Dump all form groups or labels
  const regex = /<label[^>]*>([\s\S]*?)<\/label>[\s\S]*?<div[^>]*>([\s\S]*?)<\/div>/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const l = rocket.cleanText(m[1]);
    const v = rocket.cleanText(m[2]);
    if (l && v && l.length < 50 && v.length < 150) {
      console.log('LABEL:', l, '=>', v);
    }
  }

  // Also check sub-ticket ticket_checkrepair_view.php?id=6077859363
  const subRes = await fetch('https://rocket75.com/main/ticket_checkrepair_view.php?id=6077859363', {
    headers: { Cookie: auth.cookie }
  });
  const subHtml = await subRes.text();
  console.log('Sub contains BK_SERVICE?:', subHtml.includes('BK_SERVICE'));
  if (subHtml.includes('BK_SERVICE')) {
    const idx = subHtml.indexOf('BK_SERVICE');
    console.log('Sub context of BK_SERVICE:', subHtml.substring(Math.max(0, idx - 200), idx + 200));
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
