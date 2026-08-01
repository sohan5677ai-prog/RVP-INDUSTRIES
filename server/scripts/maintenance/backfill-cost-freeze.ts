/**
 * Backfill the Pappu cost freeze onto existing sale orders.
 *
 * Why this exists: the Pappu P&L used to recompute every order from scratch on
 * each page load, so a Settings edit, a backdated stock-in, a PO verification or
 * a bank-loan re-rate all silently rewrote history. Phase 2 pins each order's
 * costs to what was true when it was taken / shipped - but only for orders
 * created from now on. This stamps the existing rows with today's computed
 * values so they stop moving too.
 *
 * What it writes:
 *   - freightRatePerTonne / prodCostPerKg  → every Pappu order (the rate the
 *     margin is currently using, so nothing changes the moment it is stamped)
 *   - seedCostSnapshot / costFrozenAt      → only orders already fully DISPATCHED;
 *     open and partial orders stay live and projected, and freeze themselves
 *     when their last lorry goes out.
 *
 * THIS MAKES TODAY'S NUMBERS PERMANENT. It is dry-run by default: it prints
 * exactly what it would write and touches nothing. Review that output, then
 * re-run with --commit.
 *
 *   npx tsx scripts/maintenance/backfill-cost-freeze.ts
 *   npx tsx scripts/maintenance/backfill-cost-freeze.ts --commit
 */
import { prisma } from '../../src/lib/prisma.js';
import { computePappuOrderMargins } from '../../src/controllers/inventory.controller.js';
import { getFreightRateForDestination } from '../../src/controllers/settings.controller.js';
import { clearCache } from '../../src/lib/cache.js';

const COMMIT = process.argv.includes('--commit');

async function main() {
  clearCache();
  const margins = await computePappuOrderMargins();
  const marginById = new Map(margins.map((m) => [m.orderId, m]));

  const orders = await prisma.saleOrder.findMany({
    where: { product: 'PAPPU' },
    include: { buyer: { select: { destination: true } } },
    orderBy: { saleDate: 'asc' },
  });

  const prodRows = await prisma.productionCostComponent.findMany({ select: { ratePerKg: true } });
  const prodCostPerKg = prodRows.reduce((s, r) => s + Number(r.ratePerKg), 0);

  const freightByDest = new Map<string, number>();
  const freightRateFor = async (dest: string | null) => {
    const key = dest ?? '';
    if (!freightByDest.has(key)) freightByDest.set(key, await getFreightRateForDestination(dest));
    return freightByDest.get(key)!;
  };

  let stampedRates = 0;
  let frozenSeed = 0;
  let skippedAlready = 0;
  let missingMargin = 0;

  console.log(COMMIT ? '=== COMMIT — writing changes ===' : '=== DRY RUN — nothing will be written ===');
  console.log(`Pappu orders: ${orders.length}   production cost: ${prodCostPerKg}/kg\n`);

  for (const so of orders) {
    const dest = so.destination ?? so.buyer?.destination ?? null;
    const freightRatePerTonne = await freightRateFor(dest);
    const m = marginById.get(so.id);
    if (!m) {
      missingMargin++;
      console.log(`  ! ${so.id}  no margin row — skipped`);
      continue;
    }

    // DELIVERED counts as fully shipped too - legacy rows reached it before the
    // freeze existed, and they are the most settled orders on the books. Missing
    // them would leave the oldest history the only part still floating.
    const alreadyFrozen = so.costFrozenAt != null;
    const fullyShipped = so.status === 'DISPATCHED' || so.status === 'DELIVERED';
    const shouldFreeze = fullyShipped && !alreadyFrozen;
    const needsRates = so.freightRatePerTonne == null || so.prodCostPerKg == null;
    if (!needsRates && !shouldFreeze) {
      skippedAlready++;
      continue;
    }

    const data: Record<string, unknown> = {};
    if (needsRates) {
      data.freightRatePerTonne = freightRatePerTonne;
      data.prodCostPerKg = prodCostPerKg;
      stampedRates++;
    }
    if (shouldFreeze) {
      data.seedCostSnapshot = { seedBands: m.seedBands, seedKg: m.seedKg, seedCost: m.seedCost };
      data.costFrozenAt = new Date();
      frozenSeed++;
    }

    console.log(
      [
        so.saleDate.toISOString().slice(0, 10),
        so.status.padEnd(10),
        (dest ?? '-').padEnd(10).slice(0, 10),
        `freight ${freightRatePerTonne}/t`,
        shouldFreeze ? `FREEZE seed ${m.seedCost.toFixed(0)} (${(m.seedKg / 1000).toFixed(2)}t)` : 'rates only',
        `margin ${m.margin.toFixed(0)}`,
      ].join('  '),
    );

    if (COMMIT) await prisma.saleOrder.update({ where: { id: so.id }, data });
  }

  console.log('\n--- summary ---');
  console.log('rates stamped     :', stampedRates);
  console.log('seed frozen       :', frozenSeed);
  console.log('already done      :', skippedAlready);
  console.log('no margin row     :', missingMargin);
  if (!COMMIT) console.log('\nNothing was written. Re-run with --commit to apply.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
