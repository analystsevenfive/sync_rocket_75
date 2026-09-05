const rocket = require('./lib/rocket-client');

async function main() {
  const auth = await rocket.rocketLogin();
  const res = await fetch('https://rocket75.com/main/ticket_view.php?id=7634722708', {
    headers: { Cookie: auth.cookie }
  });
  const html = await res.text();
  // Find where customer or date or any info is displayed
  const lines = html.split('\n')
    .map(l => rocket.cleanText(l).trim())
    .filter(l => l.length > 0 && l.length < 80);
  console.log('Unique sample lines:', lines.slice(100, 220).join('\n'));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
