const rocket = require('./lib/rocket-client');

async function main() {
  const auth = await rocket.rocketLogin();
  console.log('LOGIN OK');

  // Test 1: getInspectorModalHtml for subId 6168224191
  console.log('=== TEST 1: Inspector Modal for SubId 6168224191 ===');
  const modalSubHtml = await rocket.getInspectorModalHtml('6168224191', auth);
  console.log('Modal Sub Length:', modalSubHtml.length);
  const parsedSub = rocket.parseInspectorModal(modalSubHtml);
  console.log('Parsed Sub Modal:', JSON.stringify(parsedSub, null, 2));

  // Test 2: getInspectorModalHtml for parentId 8690619503
  console.log('=== TEST 2: Inspector Modal for ParentId 8690619503 ===');
  const modalParentHtml = await rocket.getInspectorModalHtml('8690619503', auth);
  console.log('Modal Parent Length:', modalParentHtml.length);
  const parsedParent = rocket.parseInspectorModal(modalParentHtml);
  console.log('Parsed Parent Modal:', JSON.stringify(parsedParent, null, 2));

  // Let's also print snippet of modalSubHtml around "ประเภท"
  const idx = modalSubHtml.indexOf('ประเภท');
  if (idx !== -1) {
    console.log('Snippet around ประเภท in Sub:', modalSubHtml.substring(Math.max(0, idx - 100), idx + 300));
  } else {
    console.log('Snippet (first 1000):', modalSubHtml.substring(0, 1000));
  }

  // Test 3: getOverviewHtml for parentId 8690619503
  console.log('=== TEST 3: Overview for ParentId 8690619503 ===');
  const ovHtml = await rocket.getOverviewHtml('8690619503', auth);
  const idxOv = ovHtml.indexOf('ประเภทงานปัจจุบัน');
  if (idxOv !== -1) {
    console.log('Snippet around ประเภทงานปัจจุบัน in Overview:', ovHtml.substring(Math.max(0, idxOv - 100), idxOv + 300));
  } else {
    console.log('Overview length:', ovHtml.length);
    const ovJobType = ovHtml.match(/ประเภทงาน[\s\S]*?<\/div>/i);
    console.log('Regex match in Overview:', ovJobType ? ovJobType[0] : 'None');
  }

  // Test 4: getTicketDetailHtml for subId 6168224191
  console.log('=== TEST 4: Ticket Detail for SubId 6168224191 ===');
  const detailHtml = await rocket.getTicketDetailHtml('6168224191', auth);
  const idxDet = detailHtml.indexOf('ประเภทงานปัจจุบัน');
  console.log('ประเภทงานปัจจุบัน in Detail:', idxDet !== -1 ? detailHtml.substring(idxDet - 50, idxDet + 150) : 'Not found');
  const idxDetType = detailHtml.indexOf('เปิดบิลลูกค้าภายนอก');
  console.log('เปิดบิลลูกค้าภายนอก in Detail:', idxDetType !== -1 ? detailHtml.substring(idxDetType - 50, idxDetType + 100) : 'Not found');
}

main().catch(console.error);
