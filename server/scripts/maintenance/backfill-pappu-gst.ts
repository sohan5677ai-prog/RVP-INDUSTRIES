// One-time fix for 54 PAPPU sale dispatches imported by importPappuSales.ts
// with gstAmount left at 0 (PAPPU is configured at 5% GST in Settings). This
// backfills the dispatch's gstAmount so Sale Dues/reports show GST-inclusive
// totals, and posts a correcting journal entry (Dr AR, Cr IGST Payable) so the
// GL isn't left short the GST liability that was never booked at dispatch time.
// The e-invoice/IRN filings for these are unaffected — taxpro.service.ts always
// recomputes GST from the configured rate rather than trusting this field.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const dispatches = await prisma.saleDispatch.findMany({
    where: { gstAmount: 0, saleOrder: { product: 'PAPPU' } },
    include: { saleOrder: { select: { ratePerKg: true, buyer: { select: { name: true } } } } },
  });

  console.log(`Found ${dispatches.length} zero-GST PAPPU dispatches to fix.`);

  let fixed = 0;
  for (const d of dispatches) {
    const rate = Number(d.saleOrder.ratePerKg);
    const gstAmount = Math.round(d.weightKg * rate * 0.05 * 100) / 100;
    if (gstAmount <= 0) continue;

    await prisma.$transaction(async (tx) => {
      await tx.saleDispatch.update({
        where: { id: d.id },
        data: { gstAmount },
      });

      const entry = await tx.journalEntry.create({
        data: {
          date: d.dispatchDate,
          reference: `GST-FIX-${d.id}`,
          description: `GST backfill for ${d.invoiceNumber ?? d.id} (${d.saleOrder.buyer.name}) - missing 5% IGST from import`,
        },
      });

      const ar = await tx.account.findUniqueOrThrow({ where: { code: '10100' } });
      const igst = await tx.account.findUniqueOrThrow({ where: { code: '20220' } });

      await tx.journalLine.createMany({
        data: [
          { journalEntryId: entry.id, accountId: ar.id, debit: gstAmount, credit: 0 },
          { journalEntryId: entry.id, accountId: igst.id, debit: 0, credit: gstAmount },
        ],
      });
    });

    console.log(`  Fixed ${d.invoiceNumber ?? d.id} (${d.saleOrder.buyer.name}): +GST ₹${gstAmount.toLocaleString('en-IN')}`);
    fixed++;
  }

  console.log(`\nDone. ${fixed} dispatches backfilled with GST + correcting journal entries.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
