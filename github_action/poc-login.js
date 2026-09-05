const rocket = require('./lib/rocket-client');

async function main() {
  const auth = await rocket.rocketLogin();
  const subHtml = await rocket.getTicketDetailHtml('5965647586', auth);
  const re = /<dt[^>]*>([\s\S]*?)<\/dt>[\s\S]*?<dd[^>]*>([\s\S]*?)<\/dd>/gi;
  let m;
  while ((m = re.exec(subHtml)) !== null) {
    console.log('DT:', rocket.cleanText(m[1]), '->', rocket.cleanText(m[2]));
  }
  const h5re = /<h5[^>]*>([\s\S]*?)<\/h5>[\s\S]*?<(?:label|div)[^>]*>([\s\S]*?)<\/(?:label|div)>/gi;
  while ((m = h5re.exec(subHtml)) !== null) {
    console.log('H5:', rocket.cleanText(m[1]), '->', rocket.cleanText(m[2]));
  }
}

main().catch(console.error);
