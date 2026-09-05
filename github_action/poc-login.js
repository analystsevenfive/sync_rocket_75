const rocket = require('./lib/rocket-client');

async function main() {
  const auth = await rocket.rocketLogin();
  const res = await fetch('https://rocket75.com/main/ticket_list.php', {
    headers: { Cookie: auth.cookie }
  });
  const html = await res.text();
  const m = html.match(/<select[^>]*name=["']search_type["'][^>]*>([\s\S]*?)<\/select>/i);
  if (m) {
    const optRegex = /<option[^>]*value=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi;
    let om;
    while ((om = optRegex.exec(m[1])) !== null) {
      console.log(`search_type option: val="${om[1]}" text="${rocket.cleanText(om[2])}"`);
    }
  }
}

main().catch(console.error);
