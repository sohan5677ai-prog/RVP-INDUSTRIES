/**
 * Backfill: close the sale orders that are stuck PARTIAL on a phantom balance.
 *
 * Before the close tolerance existed, an order finished only when the shipped
 * weight reached the booked tonnage exactly. A lorry never weighs exactly what
 * was booked, so every completed order left a few hundred kg of "remaining"
 * behind - worst on husk, which is loaded loose and never lands on the figure.
 *
 * This closes the ones whose shortfall is inside the tolerance now configured in
 * Settings. Orders short by MORE than the tolerance are listed but never
 * touched: those need a deliberate short close from the sales page, since only
 * the user knows whether the buyer is still sending a lorry.
 *
 * Dry run by default - pass --apply to write.
 *
 *   npx tsx scripts/maintenance/close-short-sale-orders.ts
 *   npx tsx scripts/maintenance/close-short-sale-orders.ts --apply
 */
import { PrismaClient } from '@prisma/client';
import {
  isLooseLoadedProduct,
  saleCloseToleranceKg,
  DEFAULT_SALE_CLOSE_TOLERANCE_PCT,
  DEFAULT_SALE_CLOSE_TOLERANCE_BYPRODUCT_PCT,
} from '../../src/lib/calc.js';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const t = (kg: number) => (kg / 1000).toFixed(3).padStart(9);

async function main() {
  const company = await prisma.companyProfile.findUnique({ where: { id: 'default' } });
  const pappuPct = Number(company?.saleCloseTolerancePct ?? DEFAULT_SALE_CLOSE_TOLERANCE_PCT);
  const byproductPct = Number(
    company?.saleCloseToleranceByproductPct ?? DEFAULT_SALE_CLOSE_TOLERANCE_BYPRODUCT_PCT,
  );
  console.log(`Tolerance: pappu ${pappuPct}%, husk & other byproducts ${byproductPct}%`);
  console.log(APPLY ? 'Mode: APPLY (writing)\n' : 'Mode: DRY RUN (nothing written - pass --apply)\n');

  const orders = await prisma.saleOrder.findMany({
    where: { status: { in: ['PENDING', 'PARTIAL'] }, closedAt: null },
    include: { buyer: { select: { name: true } }, dispatches: { select: { weightKg: true } } },
    orderBy: { saleDate: 'asc' },
  });

  const closable: typeof orders = [];
  const tooShort: { order: (typeof orders)[number]; shortKg: number }[] = [];

  for (const o of orders) {
    if (o.dispatches.length === 0) continue; // nothing shipped - genuinely still open
    const dispatchedKg = o.dispatches.reduce((s, d) => s + d.weightKg, 0);
    const shortKg = o.tonnageKg - dispatchedKg;
    if (shortKg <= 0) continue; // fully shipped already; status is handled elsewhere
    const pct = isLooseLoadedProduct(o.product) ? byproductPct : pappuPct;
    if (shortKg <= saleCloseToleranceKg(o.tonnageKg, pct)) closable.push(o);
    else tooShort.push({ order: o, shortKg });
  }

  console.log(`Within tolerance - will close (${closable.length}):`);
  for (const o of closable) {
    const dispatchedKg = o.dispatches.reduce((s, d) => s + d.weightKg, 0);
    const shortKg = o.tonnageKg - dispatchedKg;
    console.log(
      `  ${o.saleDate.toISOString().slice(0, 10)}  ${o.product.padEnd(18)} ${(o.buyer?.name ?? '?').slice(0, 24).padEnd(24)}` +
        ` booked ${t(o.tonnageKg)} t   out ${t(dispatchedKg)} t   short ${String(shortKg).padStart(6)} kg`,
    );
  }

  console.log(`\nBeyond tolerance - LEFT OPEN, close by hand if finished (${tooShort.length}):`);
  for (const { order: o, shortKg } of tooShort) {
    const dispatchedKg = o.dispatches.reduce((s, d) => s + d.weightKg, 0);
    console.log(
      `  ${o.saleDate.toISOString().slice(0, 10)}  ${o.product.padEnd(18)} ${(o.buyer?.name ?? '?').slice(0, 24).padEnd(24)}` +
        ` booked ${t(o.tonnageKg)} t   out ${t(dispatchedKg)} t   short ${String(shortKg).padStart(6)} kg`,
    );
  }

  if (!APPLY) {
    console.log('\nDry run - nothing written. Re-run with --apply to close the list above.');
    return;
  }

  for (const o of closable) {
    const dispatchedKg = o.dispatches.reduce((s, d) => s + d.weightKg, 0);
    const shortKg = o.tonnageKg - dispatchedKg;
    await prisma.saleOrder.update({
      where: { id: o.id },
      data: {
        status: 'DISPATCHED',
        closedAt: new Date(),
        closeReason: `Backfill: final lorry landed ${shortKg} kg under the booked tonnage - within tolerance`,
      },
    });
  }
  console.log(`\nClosed ${closable.length} order(s).`);
  console.log('NOTE: Pappu orders closed here are not cost-frozen by this script - the margin page');
  console.log('freezes them the next time they are touched, or leave them computing live.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
