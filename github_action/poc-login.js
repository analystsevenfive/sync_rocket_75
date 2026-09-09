const rocket = require('./lib/rocket-client');

// Updated regex logic
function testExtractCheckRepairIds(html) {
  const ids = [];
  const regex = /ticket_checkrepair_view(?:_fast)?\.php\?id=(\d+)/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    ids.push(m[1]);
  }
  const trRegex = /<tr\s+id=["']tr_(\d+)["']/gi;
  while ((m = trRegex.exec(html)) !== null) {
    ids.push(m[1]);
  }
  return [...new Set(ids)];
}

async function main() {
  const auth = await rocket.rocketLogin();
  console.log('LOGIN OK');

  const range = rocket.computeTodayRangeBangkok();
  console.log('Today:', range.start);

  const parentHtml = await rocket.getParentTicketHtml(auth, range.start, range.end, '2');
  const parentIds = rocket.extractParentTicketIds(parentHtml);
  console.log('Parent IDs found:', parentIds.length);

  let totalCandidateSub = 0;
  for (let i = 0; i < Math.min(5, parentIds.length); i++) {
    const pid = parentIds[i];
    const crHtml = await rocket.getCheckRepairHtml(pid, auth);
    const subIds = testExtractCheckRepairIds(crHtml);
    console.log(`Parent ${pid} -> Sub IDs:`, subIds);
    totalCandidateSub += subIds.length;

    if (subIds.length > 0) {
      const firstSubId = subIds[0];
      const detailHtml = await rocket.getTicketDetailHtml(firstSubId, auth);
      const ticket = rocket.parseTicketDetail(detailHtml, firstSubId);
      console.log(`  Detail of ${firstSubId}:`, {
        ticketNo: ticket.ticketNo,
        status: ticket.status,
        appointment: ticket.appointment,
        customer: ticket.customer,
        technician: ticket.technician
      });
    }
  }

  console.log('Total candidate subs in sample:', totalCandidateSub);
}

main().catch(console.error);
