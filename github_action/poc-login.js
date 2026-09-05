const rocket = require('./lib/rocket-client');

async function main() {
  const auth = await rocket.rocketLogin();
  const res = await fetch('https://rocket75.com/main/ticket_view.php?id=7634722708', {
    headers: { Cookie: auth.cookie }
  });
  const html = await res.text();
  const matches = html.match(/ajax\/[^\s'"]+/gi) || [];
  console.log('AJAX endpoints on ticket_view:', [...new Set(matches)]);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
