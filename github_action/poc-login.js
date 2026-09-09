const rocket = require('./lib/rocket-client');

async function main() {
  const auth = await rocket.rocketLogin();
  console.log('LOGIN OK, auth:', { token: auth.token ? 'yes' : 'no', key: auth.key ? 'yes' : 'no', cookie: auth.cookie ? 'yes' : 'no' });

  // 1. Get parents for today (09/09/2026)
  const range = rocket.computeTodayRangeBangkok();
  console.log('Date range today:', range.start);
  const parentHtml = await rocket.getParentTicketHtml(auth, range.start, range.end, '2');
  const parentIds = rocket.extractParentTicketIds(parentHtml);
  console.log('Parent IDs found:', parentIds.length, parentIds.slice(0, 5));

  if (parentIds.length === 0) {
    console.log('No parents found! Parent HTML snippet:');
    console.log(parentHtml.substring(0, 500));
    return;
  }

  // Test the first 2 parents
  for (let i = 0; i < Math.min(2, parentIds.length); i++) {
    const pid = parentIds[i];
    console.log(`\n--- Testing Parent ID: ${pid} ---`);
    const crHtml = await rocket.getCheckRepairHtml(pid, auth);
    console.log('checkrepair.php HTML length:', crHtml.length);
    console.log('checkrepair.php snippet (first 1500 chars):');
    console.log(crHtml.substring(0, 1500));
    console.log('\ncheckrepair.php snippet (characters 1500 - 3000):');
    console.log(crHtml.substring(1500, 3000));
    const subIds = rocket.extractCheckRepairIds(crHtml);
    console.log('extractCheckRepairIds result:', subIds);
    const info = rocket.extractCheckRepairInfo(crHtml);
    console.log('extractCheckRepairInfo result:', info);

    // Also let's check ticket_view.php for this parent
    const pvHtml = await rocket.getParentPageHtml(pid, auth);
    console.log('ticket_view.php length:', pvHtml.length);
    const crMatchesInParent = pvHtml.match(/ticket_checkrepair_view\.php\?id=\d+/gi);
    console.log('ticket_checkrepair_view matches in ticket_view.php:', crMatchesInParent);
  }
}

main().catch(console.error);
