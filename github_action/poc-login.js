const rocket = require('./lib/rocket-client');

async function main() {
  const auth = await rocket.rocketLogin();
  const res = await fetch('https://rocket75.com/hr/organization_chart.php', {
    headers: { Cookie: auth.cookie }
  });
  const html = await res.text();
  console.log('Org chart length:', html.length);
  console.log('Has แววดาว?:', html.includes('แววดาว'));
  if (html.includes('แววดาว')) {
    const idx = html.indexOf('แววดาว');
    console.log('Context แววดาว:', html.substring(Math.max(0, idx - 100), idx + 100));
  }
  console.log('Has รัตนา?:', html.includes('รัตนา'));
  if (html.includes('รัตนา')) {
    const idx = html.indexOf('รัตนา');
    console.log('Context รัตนา:', html.substring(Math.max(0, idx - 100), idx + 100));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
