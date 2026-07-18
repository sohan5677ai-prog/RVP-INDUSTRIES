import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { LedgerService } from '../src/services/ledger.service.js';

const prisma = new PrismaClient();

/**
 * One-off: post the missing sale revenue for the 3 WASTE dispatches that were
 * loaded straight into the DB (orders + dispatches) without going through the
 * normal dispatch flow, so their revenue never hit the ledger. This posts the
 * same two-line sale entry postSale would (GST/freight/COGS are all 0 on these),
 * dated on the real sale date, keyed `SALE-<dispatchId>` so undoSaleDispatch can
 * still reverse it. Idempotent: skips any dispatch that already has its posting.
 */
async function main() {
  const orders = await prisma.saleOrder.findMany({
    where: { product: 'WASTE' },
    include: { buyer: true, dispatches: true },
    orderBy: { saleDate: 'asc' },
  });

  const acct = await prisma.account.findUnique({ where: { code: '40010' }, select: { id: true } });
  const before = await prisma.journalLine.aggregate({
    _sum: { credit: true, debit: true },
    where: { accountId: acct!.id, costCenter: 'WASTE' },
  });
  console.log(`40010/WASTE before: ₹${(Number(before._sum.credit ?? 0) - Number(before._sum.debit ?? 0)).toFixed(2)}\n`);

  for (const so of orders) {
    for (const d of so.dispatches) {
      const ref = `SALE-${d.id}`;
      const existing = await prisma.journalEntry.findFirst({ where: { reference: ref } });
      if (existing) { console.log(`SKIP ${d.invoiceNumber} — ${ref} already posted`); continue; }

      const base = Math.round(d.weightKg * Number(so.ratePerKg) * 100) / 100;
      await prisma.$transaction(async (tx) => {
        await LedgerService.postJournalEntry(tx, {
          date: so.saleDate,
          reference: ref,
          description: `Sale dispatch of ${d.weightKg} kg ${so.product} to buyer ${so.buyer?.name ?? '-'}`,
          lines: [
            { accountCode: '10100', debit: base, credit: 0 },
            { accountCode: '40010', debit: 0, credit: base, costCenter: 'WASTE' },
          ],
        });
      });
      console.log(`POSTED ${d.invoiceNumber}  ${d.weightKg}kg @ ₹${so.ratePerKg}  →  Dr 10100 / Cr 40010(WASTE) ₹${base.toFixed(2)}`);
    }
  }

  const after = await prisma.journalLine.aggregate({
    _sum: { credit: true, debit: true },
    where: { accountId: acct!.id, costCenter: 'WASTE' },
  });
  console.log(`\n40010/WASTE after: ₹${(Number(after._sum.credit ?? 0) - Number(after._sum.debit ?? 0)).toFixed(2)}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
