// One-off backfill: give every existing SaleOrder its RVP-<NICK>/<NN>/<FY>
// order number (see src/lib/saleOrderNumber.ts). Orders booked before the
// scheme existed carry none, which leaves the buyer's confirmation message
// quoting a dash.
//
// Numbers are handed out in saleDate order within each (buyer, FY) series, so
// an older order always gets a lower serial than a newer one - the sequence
// reads as the history it describes rather than as the order the rows happen
// to come back in. The counter rows are then set to each series' highest
// serial, so the next order booked continues the run instead of colliding.
//
// Dry run by default; pass --apply to write.
import { prisma } from '../src/lib/prisma.js';
import {
  computeSaleFy,
  formatSaleOrderNumber,
  saleSeriesKeyForBuyer,
} from '../src/lib/saleOrderNumber.js';
import { writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');

async function main() {
  const orders = await prisma.saleOrder.findMany({
    where: { orderNumber: null },
    include: { buyer: { select: { name: true, nickname: true } } },
    orderBy: [{ saleDate: 'asc' }, { createdAt: 'asc' }],
  });

  if (orders.length === 0) {
    console.log('Nothing to do - every sale order already has a number.');
    return;
  }

  // Seed each series from what is already numbered, so a re-run (or a backfill
  // over a table that has both old and new orders) never reissues a number.
  const used = await prisma.saleOrder.findMany({
    where: { orderNumber: { not: null } },
    select: { orderSeriesKey: true, orderFy: true, orderSerial: true },
  });
  const nextSerial = new Map<string, number>();
  for (const u of used) {
    if (!u.orderSeriesKey || !u.orderFy || u.orderSerial == null) continue;
    const key = `${u.orderSeriesKey}|${u.orderFy}`;
    nextSerial.set(key, Math.max(nextSerial.get(key) ?? 0, u.orderSerial));
  }

  const plan = orders.map((o) => {
    const seriesKey = saleSeriesKeyForBuyer(o.buyer);
    const fy = computeSaleFy(o.saleDate);
    const key = `${seriesKey}|${fy}`;
    const serial = (nextSerial.get(key) ?? 0) + 1;
    nextSerial.set(key, serial);
    return {
      id: o.id,
      buyer: o.buyer.name,
      saleDate: o.saleDate.toISOString().slice(0, 10),
      orderSeriesKey: seriesKey,
      orderFy: fy,
      orderSerial: serial,
      orderNumber: formatSaleOrderNumber(seriesKey, serial, fy),
    };
  });

  console.log(`${plan.length} sale order(s) to number:\n`);
  for (const p of plan.slice(0, 40)) {
    console.log(`  ${p.orderNumber.padEnd(22)} ${p.saleDate}  ${p.buyer}`);
  }
  if (plan.length > 40) console.log(`  ... and ${plan.length - 40} more`);

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write.');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `scripts/backup_sale_order_numbers_${stamp}.json`;
  writeFileSync(backupPath, JSON.stringify(plan, null, 2));
  console.log(`\nBackup written: ${backupPath}`);

  for (const p of plan) {
    await prisma.saleOrder.update({
      where: { id: p.id },
      data: {
        orderNumber: p.orderNumber,
        orderSeriesKey: p.orderSeriesKey,
        orderSerial: p.orderSerial,
        orderFy: p.orderFy,
      },
    });
  }

  // Park each counter on its series' highest serial.
  for (const [key, lastSerial] of nextSerial) {
    const [seriesKey, fy] = key.split('|');
    await prisma.saleSerialCounter.upsert({
      where: { seriesKey_fy: { seriesKey, fy } },
      create: { seriesKey, fy, lastSerial },
      update: { lastSerial },
    });
  }

  console.log(`Done. ${plan.length} order(s) numbered, ${nextSerial.size} series counter(s) set.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
