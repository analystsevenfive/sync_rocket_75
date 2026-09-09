const rocket = require('./lib/rocket-client');

async function main() {
  const auth = await rocket.rocketLogin();
  console.log('LOGIN OK');

  const subId = '9964638966';
  console.log('--- Test GET ticket_checkrepair_view.php?id=' + subId + ' ---');
  try {
    const res1 = await rocket.getTicketDetailHtml(subId, auth);
    console.log('ticket_checkrepair_view.php length:', res1.length);
    const parsed1 = rocket.parseTicketDetail(res1, subId);
    console.log('Parsed ticket_checkrepair_view.php:', {
      ticketNo: parsed1.ticketNo,
      status: parsed1.status,
      appointment: parsed1.appointment,
      customer: parsed1.customer
    });
  } catch (e) {
    console.log('Error ticket_checkrepair_view.php:', e.message);
  }

  console.log('--- Test GET ticket_checkrepair_view_fast.php?id=' + subId + ' ---');
  try {
    const headers = { Referer: rocket.ROCKET_BASE + '/main/' };
    if (auth.cookie) headers.Cookie = auth.cookie;
    const res2 = await rocket.fetchWithTimeout(
      rocket.ROCKET_BASE + '/main/ticket_checkrepair_view_fast.php?id=' + subId,
      { method: 'GET', headers: headers, redirect: 'follow' }
    );
    console.log('ticket_checkrepair_view_fast.php HTTP status:', res2.status);
    const text2 = await res2.text();
    console.log('ticket_checkrepair_view_fast.php length:', text2.length);
    const parsed2 = rocket.parseTicketDetail(text2, subId);
    console.log('Parsed ticket_checkrepair_view_fast.php:', {
      ticketNo: parsed2.ticketNo,
      status: parsed2.status,
      appointment: parsed2.appointment,
      customer: parsed2.customer
    });
  } catch (e) {
    console.log('Error ticket_checkrepair_view_fast.php:', e.message);
  }
}

main().catch(console.error);
