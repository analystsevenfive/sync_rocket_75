/*************************************************
 * POC — ทดสอบว่า rocket75.com ยอมรับ request จาก
 * GitHub Actions runner ไหม (คนละ IP range จาก
 * Apps Script) ก่อนจะลงแรงพอร์ตทั้งระบบเป็น Node.js
 *
 * ทดสอบ 2 ขั้น:
 *   1. Login (auth.php) ได้ token/key ไหม
 *   2. ยิง AJAX จริง (getTable.php) ด้วย token/key
 *      นั้น ได้ parent ticket กลับมาไหม (ยืนยันว่าไม่ใช่
 *      แค่ login ผ่านแต่ AJAX endpoint อื่นโดนบล็อก)
 *************************************************/

async function main() {

  const username = process.env.ROCKET_USERNAME;
  const password = process.env.ROCKET_PASSWORD;

  if (!username || !password) {
    throw new Error('ไม่พบ ROCKET_USERNAME / ROCKET_PASSWORD ใน environment variables');
  }

  const base = 'https://rocket75.com';

  // ==========================================
  // STEP 1: GET index.php (ดูว่ามี Set-Cookie ไหม —
  // ตาม Apps Script เดิมไม่เคยมี ควรจะเหมือนกัน)
  // ==========================================

  const firstRes = await fetch(base + '/index.php', {
    method: 'GET',
    redirect: 'manual'
  });

  console.log('GET /index.php status:', firstRes.status);

  const firstSetCookie = firstRes.headers.get('set-cookie');
  console.log('Set-Cookie จาก /index.php:', firstSetCookie || '(ไม่มี — ตามที่คาด)');

  let cookie = '';
  const firstMatch = firstSetCookie && firstSetCookie.match(/PHPSESSID=([^;]+)/i);
  if (firstMatch) {
    cookie = 'PHPSESSID=' + firstMatch[1];
  }

  // ==========================================
  // STEP 2: POST auth.php
  // ==========================================

  const loginBody = new URLSearchParams();
  loginBody.set('username', username);
  loginBody.set('password', password);

  const loginHeaders = {
    Origin: base,
    Referer: base + '/index.php',
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest'
  };
  if (cookie) {
    loginHeaders.Cookie = cookie;
  }

  const loginRes = await fetch(base + '/auth.php', {
    method: 'POST',
    headers: loginHeaders,
    body: loginBody,
    redirect: 'manual'
  });

  console.log('POST /auth.php status:', loginRes.status);

  const loginText = await loginRes.text();
  console.log('Response (500 ตัวแรก):', loginText.substring(0, 500));

  let data;
  try {
    data = JSON.parse(loginText);
  } catch (e) {
    console.error('auth.php ไม่คืน JSON — อาจโดนบล็อกหรือ IP นี้ได้รับการตอบสนองต่างจาก Apps Script');
    process.exit(1);
  }

  console.log('sing:', data.sing);
  console.log('token present:', Boolean(data.token));
  console.log('key present:', Boolean(data.key));

  if (Number(data.sing) !== 1 || !data.token || !data.key) {
    console.log('LOGIN FAILED — sing=' + data.sing);
    process.exit(1);
  }

  console.log('LOGIN SUCCESS — rocket75.com รับ request login จาก GitHub Actions runner ได้');

  const newSetCookie = loginRes.headers.get('set-cookie');
  const newMatch = newSetCookie && newSetCookie.match(/PHPSESSID=([^;]+)/i);
  if (newMatch) {
    cookie = 'PHPSESSID=' + newMatch[1];
  }

  // ==========================================
  // STEP 3: ยิง AJAX จริง (getTable.php) ด้วย
  // token/key ที่ได้ ยืนยันว่า endpoint อื่นใช้ได้จริง
  // ไม่ใช่แค่ auth.php เท่านั้นที่ผ่าน
  // ==========================================

  const tableBody = new URLSearchParams();
  tableBody.set('status', '');
  tableBody.set('start_date', '01/08/2026');
  tableBody.set('end_date', '28/08/2026');
  tableBody.set('search_checkrepair', 'x');
  tableBody.set('name_search', '');
  tableBody.set('search_team', 'x');
  tableBody.set('search_staff', 'x');
  tableBody.set('token', data.token);
  tableBody.set('key', data.key);
  tableBody.set('search_type', 'x');
  tableBody.set('search_area', 'x');
  tableBody.set('date_type', '1');
  tableBody.set('search_warranty_type', 'x');

  const tableHeaders = {
    Origin: base,
    Referer: base + '/main/ticket_list.php',
    'X-Requested-With': 'XMLHttpRequest'
  };
  if (cookie) {
    tableHeaders.Cookie = cookie;
  }

  const tableRes = await fetch(base + '/main/ajax/ticket/getTable.php', {
    method: 'POST',
    headers: tableHeaders,
    body: tableBody
  });

  console.log('POST getTable.php status:', tableRes.status);

  const tableHtml = await tableRes.text();
  console.log('getTable.php response length:', tableHtml.length);

  const rocket = require('./lib/rocket-client');
  // Search for BKIN0826-000635
  const searchBody = new URLSearchParams();
  searchBody.set('status', '');
  searchBody.set('start_date', '01/08/2026');
  searchBody.set('end_date', '05/09/2026');
  searchBody.set('search_checkrepair', 'x');
  searchBody.set('name_search', 'BKIN0826-000635');
  searchBody.set('search_team', 'x');
  searchBody.set('search_staff', 'x');
  searchBody.set('token', data.token);
  searchBody.set('key', data.key);
  searchBody.set('search_type', 'x');
  searchBody.set('search_area', 'x');
  searchBody.set('date_type', '1');
  searchBody.set('search_warranty_type', 'x');

  const sRes = await fetch(base + '/main/ajax/ticket/getTable.php', {
    method: 'POST',
    headers: {
      Origin: base,
      Referer: base + '/main/ticket_list.php',
      'X-Requested-With': 'XMLHttpRequest',
      Cookie: cookie
    },
    body: searchBody
  });
  const sHtml = await sRes.text();
  console.log('Search getTable length:', sHtml.length);
  const pMatch = sHtml.match(/ticket_view\.php\?id=(\d+)/i);
  console.log('Parent ID match:', pMatch ? pMatch[1] : 'None');
  if (pMatch) {
    const parentId = pMatch[1];
    // get checkrepair sub-tickets
    const crHtml = await rocket.getCheckRepairHtml(parentId, { cookie, token: data.token, key: data.key });
    const subIds = rocket.extractCheckRepairIds(crHtml);
    console.log('Sub IDs:', subIds);
    if (subIds.length > 0) {
      const subHtml = await rocket.getTicketDetailHtml(subIds[0], { cookie });
      console.log('=== SubTicket detail HTML snippet ===');
      // dump all text and dt/dd
      const re = /<dt[^>]*>([\s\S]*?)<\/dt>[\s\S]*?<dd[^>]*>([\s\S]*?)<\/dd>/gi;
      let m;
      while ((m = re.exec(subHtml)) !== null) {
        console.log('DT:', rocket.cleanText(m[1]), '->', rocket.cleanText(m[2]));
      }
      // check any other blocks
      const h5re = /<h5[^>]*>([\s\S]*?)<\/h5>[\s\S]*?<(?:label|div)[^>]*>([\s\S]*?)<\/(?:label|div)>/gi;
      while ((m = h5re.exec(subHtml)) !== null) {
        console.log('H5:', rocket.cleanText(m[1]), '->', rocket.cleanText(m[2]));
      }
    }
    // Also check parent ticket_view.php HTML
    const parentRes = await fetch(base + '/main/ticket_view.php?id=' + parentId, { headers: { Cookie: cookie } });
    const parentHtml = await parentRes.text();
    console.log('=== Parent ticket_view HTML snippet ===');
    const pDtre = /<dt[^>]*>([\s\S]*?)<\/dt>[\s\S]*?<dd[^>]*>([\s\S]*?)<\/dd>/gi;
    let pm;
    while ((pm = pDtre.exec(parentHtml)) !== null) {
      console.log('Parent DT:', rocket.cleanText(pm[1]), '->', rocket.cleanText(pm[2]));
    }
    // check table row in getTable
    console.log('=== Row in getTable ===');
    const trm = sHtml.match(/<tr[^>]*>[\s\S]*?<\/tr>/i);
    if (trm) console.log(trm[0].substring(0, 1500));
  }

}

main().catch(function(err) {

  console.error('PoC ล้มเหลว:', err);
  process.exit(1);

});
