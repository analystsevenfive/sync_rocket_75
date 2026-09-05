const rocket = require('./lib/rocket-client');

async function main() {
  const auth = await rocket.rocketLogin();
  console.log('LOGIN OK');

  // Check ModalProduct for BKIN0826-000635 product id 2654458489
  const pHtml = await rocket.getModalProductHtml('2654458489', auth);
  console.log('ModalProduct 2654458489 length:', pHtml.length);

  const labelRegex = /<label[^>]*>([\s\S]*?)<\/label>[\s\S]*?<input[^>]*value=["']([^"']*)["']/gi;
  let m;
  while ((m = labelRegex.exec(pHtml)) !== null) {
    console.log('ModalProduct field:', rocket.cleanText(m[1]), '=>', rocket.cleanText(m[2]));
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
