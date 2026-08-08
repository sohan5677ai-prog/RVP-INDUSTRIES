// One-off correction: some buyer receipts carry a shortage deduction with 5% GST
// applied TWICE (base x 1.05^2 instead of base x 1.05).
//
// The three entry dialogs all prefill the shortage field with the GOODS value
// (shortageKg x ratePerKg) and add 5% on submit. A gross, GST-inclusive figure
// typed into that field by hand gets the 5% applied a second time. The result is
// a deduction ~5% larger than the kata slip supports.
//
// WHICH NUMBER IS WRONG MATTERS, and the database cannot tell us:
//
//   --mode=cash      The bank credit is the fact; the stored `amount` was
//                    auto-filled from the bad shortage and never reconciled.
//                    Corrects BOTH the shortage and the cash, leaving the
//                    invoice fully settled. Use when the bank statement shows
//                    the buyer paid MORE than the recorded receipt amount.
//
//   --mode=shortage  The buyer really did withhold the larger sum. Only the
//                    shortage is relabelled to the kata-supported figure; the
//                    cash stays as banked, so the invoice becomes SHORT by the
//                    difference - a genuine receivable to chase or write off.
//                    Use when the bank statement matches the recorded amount.
//
// Dry run by default; pass --apply to write. A JSON backup of the prior state is
// written either way (when there are changes).
//
//   node --import tsx scripts/fix-double-gst-shortages.ts --mode=cash
//   node --import tsx scripts/fix-double-gst-shortages.ts --mode=cash --apply
import { prisma } from '../src/lib/prisma.js';
import { writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const MODE = (process.argv.find((a) => a.startsWith('--mode='))?.split('=')[1] ?? '') as
  | 'cash'
  | 'shortage'
  | '';
/** Ignore sub-rupee drift - bills round to whole rupees while deductions carry paise. */
const TOLERANCE = 1;

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

async function main() {
  if (MODE !== 'cash' && MODE !== 'shortage') {
    console.error(
      'Refusing to run without an explicit remedy.\n' +
        '  --mode=cash      bank credit is right, the recorded cash was auto-filled -> fix shortage AND cash\n' +
        '  --mode=shortage  bank credit matches what we recorded -> fix shortage only, invoice goes short\n',
    );
    process.exitCode = 1;
    return;
  }

  // Every buyer receipt tied to a shipment that has a real buyer-kata slip. The
  // kata slip is what makes a correct figure knowable at all - without one there
  // is nothing to check the stored amount against, so those are left alone.
  const receipts = await prisma.receipt.findMany({
    where: { type: 'BUYER', saleDispatchId: { not: null }, shortageAmount: { gt: 0 } },
    include: {
      party: { select: { name: true } },
      saleDispatch: {
        include: { saleOrder: { select: { product: true, ratePerKg: true, gstExempt: true } } },
      },
    },
    orderBy: { date: 'asc' },
  });

  const affected = [];
  for (const r of receipts) {
    const d = r.saleDispatch!;
    const kg = Number(d.shortageKg ?? 0);
    if (kg <= 0) continue; // no kata slip -> nothing to verify against

    const rate = Number(d.saleOrder.ratePerKg);
    const gstFactor = d.saleOrder.gstExempt ? 1 : 1.05;
    const correctShortage = r2(kg * rate * gstFactor);
    const storedShortage = Number(r.shortageAmount);
    const delta = r2(storedShortage - correctShortage);
    if (Math.abs(delta) <= TOLERANCE) continue;

    affected.push({
      receiptId: r.id,
      invoiceNumber: d.invoiceNumber,
      party: r.party?.name ?? '-',
      date: r.date.toISOString().slice(0, 10),
      dispatchId: d.id,
      shortageKg: kg,
      ratePerKg: rate,
      storedShortage,
      correctShortage,
      delta,
      storedAmount: Number(r.amount),
      // In cash mode the buyer withheld less than we recorded, so MORE cash landed.
      correctAmount: r2(Number(r.amount) + delta),
      storedCreditNoteAmount: Number(d.creditNoteAmount ?? 0),
    });
  }

  if (affected.length === 0) {
    console.log('Nothing to do - every kata-backed shortage already matches kg x rate + GST.');
    return;
  }

  console.log(`Receipts with a double-GST shortage: ${affected.length}   mode=${MODE}   ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);
  let totalDelta = 0;
  for (const a of affected) {
    totalDelta += a.delta;
    console.log(`${(a.invoiceNumber ?? '-').padEnd(14)} ${a.party}`);
    console.log(`  ${a.shortageKg} kg @ ${a.ratePerKg}  shortage ${a.storedShortage} -> ${a.correctShortage}  (over by ${a.delta})`);
    if (MODE === 'cash') {
      console.log(`  cash received ${a.storedAmount} -> ${a.correctAmount}  (invoice stays fully settled)`);
    } else {
      console.log(`  cash received ${a.storedAmount} unchanged  -> invoice goes SHORT by ${a.delta}`);
    }
  }
  console.log(`\nTotal over-deduction: ${r2(totalDelta)}`);

  const backup = { takenAt: new Date().toISOString(), mode: MODE, rows: affected };
  const backupPath = `shortage-fix-backup-${Date.now()}.json`;
  writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`Backup of prior state: ${backupPath}`);

  if (!APPLY) {
    console.log('\nDry run - nothing written. Re-run with --apply to commit.');
    return;
  }

  for (const a of affected) {
    await prisma.$transaction(async (tx) => {
      // 1. The receipt itself.
      await tx.receipt.update({
        where: { id: a.receiptId },
        data: {
          shortageAmount: a.correctShortage,
          ...(MODE === 'cash' && { amount: a.correctAmount }),
        },
      });

      // 2. The shortage stamped on the dispatch by "Mark as Paid".
      if (Math.abs(a.storedCreditNoteAmount - a.storedShortage) <= TOLERANCE) {
        await tx.saleDispatch.update({
          where: { id: a.dispatchId },
          data: { creditNoteAmount: a.correctShortage },
        });
      }

      // 3. The shortage posting: Dr 50100 Sales Shortage / Cr 10100 A/R.
      const shortageJe = await tx.journalEntry.findFirst({
        where: { reference: `SHORTAGE-${a.dispatchId}` },
        include: { lines: true },
      });
      for (const line of shortageJe?.lines ?? []) {
        await tx.journalLine.update({
          where: { id: line.id },
          data: {
            ...(Number(line.debit) > 0 && { debit: a.correctShortage }),
            ...(Number(line.credit) > 0 && { credit: a.correctShortage }),
          },
        });
      }

      // 4. The receipt posting: Dr 10400 Bank / Cr 10100 A/R, for the cash only.
      //    Untouched in shortage mode - the banked amount did not change there.
      if (MODE === 'cash') {
        const receiptJe = await tx.journalEntry.findFirst({
          where: { reference: `RECEIPT-${a.receiptId}` },
          include: { lines: true },
        });
        for (const line of receiptJe?.lines ?? []) {
          await tx.journalLine.update({
            where: { id: line.id },
            data: {
              ...(Number(line.debit) > 0 && { debit: a.correctAmount }),
              ...(Number(line.credit) > 0 && { credit: a.correctAmount }),
            },
          });
        }
      }
    });
    console.log(`fixed ${a.invoiceNumber ?? a.receiptId}`);
  }

  console.log(`\nDone - ${affected.length} receipts corrected.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
