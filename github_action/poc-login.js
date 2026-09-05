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

  const idMatches = tableHtml.match(/ticket_view\.php\?id=(\d+)/gi) || [];
  const uniqueIds = new Set(idMatches);

  console.log('Parent ticket ID ที่เจอ:', uniqueIds.size);

  console.log('--- DIAGNOSTIC FOR TICKET 7634722708 ---');
  const tvRes = await fetch(base + '/main/ticket_view.php?id=7634722708', {
    headers: { Cookie: cookie }
  });
  const tvHtml = await tvRes.text();
  console.log('ticket_view.php status:', tvRes.status, 'length:', tvHtml.length);

  const dtMatches = tvHtml.match(/<dt[^>]*>[\s\S]*?<\/dt>[\s\S]*?<dd[^>]*>[\s\S]*?<\/dd>/gi) || [];
  console.log('Found DT/DD count:', dtMatches.length);
  dtMatches.forEach(m => {
    if (m.includes('ที่อยู่') || m.includes('สาขา') || m.includes('ลูกค้า') || m.includes('Location')) {
      console.log('DT/DD match:', m.replace(/\s+/g, ' '));
    }
  });

  const crRes = await fetch(base + '/main/ajax/ticket_view/checkrepair.php', {
    method: 'POST',
    headers: {
      Origin: base,
      Referer: base + '/main/ticket_view.php?id=7634722708',
      'X-Requested-With': 'XMLHttpRequest',
      Cookie: cookie
    },
    body: new URLSearchParams({
      id: '7634722708',
      ticket_id: '7634722708',
      token: token,
      key: key
    })
  });
  const crHtml = await crRes.text();
  console.log('checkrepair.php length:', crHtml.length);
  const subMatches = crHtml.match(/ticket_checkrepair_view\.php\?id=(\d+)/i);
  if (subMatches) {
    const subId = subMatches[1];
    console.log('Sub ticket ID:', subId);
    const subRes = await fetch(base + '/main/ticket_checkrepair_view.php?id=' + subId, {
      headers: { Cookie: cookie }
    });
    const subHtml = await subRes.text();
    const subDtMatches = subHtml.match(/<dt[^>]*>[\s\S]*?<\/dt>[\s\S]*?<dd[^>]*>[\s\S]*?<\/dd>/gi) || [];
    subDtMatches.forEach(m => {
      if (m.includes('ที่อยู่') || m.includes('สาขา')) {
        console.log('Sub DT/DD match:', m.replace(/\s+/g, ' '));
      }
    });
  }

}

main().catch(function(err) {

  console.error('PoC ล้มเหลว:', err);
  process.exit(1);

});
