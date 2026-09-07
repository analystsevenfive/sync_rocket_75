const rocket = require('./lib/rocket-client');

async function main() {
  const auth = await rocket.rocketLogin();
  console.log('LOGIN OK');

  const parentId = '8690619503';
  const ovHtml = await rocket.getOverviewHtml(parentId, auth);
  console.log('Search in overview.php:');
  console.log('indexOf เปิดบิลลูกค้าภายนอก:', ovHtml.indexOf('เปิดบิลลูกค้าภายนอก'));
  console.log('indexOf ประเภทงาน:', ovHtml.indexOf('ประเภทงาน'));

  const parentHtml = await rocket.getParentPageHtml(parentId, auth);
  console.log('Search in ticket_view.php:');
  console.log('indexOf เปิดบิลลูกค้าภายนอก:', parentHtml.indexOf('เปิดบิลลูกค้าภายนอก'));
  const idx = parentHtml.indexOf('ประเภทงานปัจจุบัน');
  console.log('indexOf ประเภทงานปัจจุบัน:', idx);
  if (idx !== -1) {
    console.log('Snippet around ประเภทงานปัจจุบัน in ticket_view.php:');
    console.log(parentHtml.substring(idx - 50, idx + 200));
  }
}

main().catch(console.error);
