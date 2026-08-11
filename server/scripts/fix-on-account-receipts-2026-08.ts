// One-off repair: three buyer collections were recorded with no saleDispatchId,
// so they credited the party ledger but cleared no invoice - the bills they paid
// kept reading Unpaid on Sale Dues and the statement printed them with a blank
// Invoice column. Each was one bank transfer covering one or more invoices, which
// the old single-invoice picker could not express.
//
// This rewrites each of them as one Receipt row per invoice (the shape
// settledByDispatch/isDispatchPaid needs), reversing the original posting and
// re-posting the splits inside a single transaction. Cash totals are unchanged -
// only the deductions are restated from the invoice's own recorded figures:
//   • shortage = dispatch.creditNoteAmount (kata goods value + 5% GST)
//   • TDS      = 0.1% of the sale value excluding GST
// so every invoice lands exactly on its bill.
//
// Dry run by default; pass --apply to write. A JSON backup of the three original
// receipts is saved either way.
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { prisma } from '../src/lib/prisma.js';
import { LedgerService } from '../src/services/ledger.service.js';

const APPLY = process.argv.includes('--apply');

interface Split {
  saleDispatchId: string;
  invoice: string;
  amount: number;
  tdsAmount: number;
  shortageAmount: number;
}

interface Repair {
  receiptId: string;
  label: string;
  splits: Split[];
}

// Figures below are each invoice's own recorded numbers (bill, creditNoteAmount,
// 0.1% of base); the cash is the remainder, and every split's cash sums back to
// the original receipt amount exactly.
const REPAIRS: Repair[] = [
  {
    receiptId: 'cmsndd15i003wj32dwri09e2i',
    label: 'Soham Agro Tech - 10 Aug 2026 - Rs 15,96,402',
    splits: [
      { saleDispatchId: 'cmseem1oy000elu2dvc9vqgbn', invoice: 'RVP/109/26-27', amount: 1596402, tdsAmount: 1530, shortageAmount: 8568 },
    ],
  },
  {
    receiptId: 'cmsndbxs7003mj32dkupzu1mk',
    label: 'Colourtex Industries Private Ltd - 10 Aug 2026 - Rs 30,98,897',
    splits: [
      { saleDispatchId: 'cmrs60rvy008tcf2d0adrs4of', invoice: 'RVP/74/26-27', amount: 1548409, tdsAmount: 1485, shortageAmount: 9356 },
      { saleDispatchId: 'cmrs616f40099cf2dnmu291hw', invoice: 'RVP/75/26-27', amount: 1550488, tdsAmount: 1485, shortageAmount: 7277 },
    ],
  },
  {
    receiptId: 'cmsnawkvn000vj32dtxn2j5oc',
    label: 'Sri Lakshmi Venkateswara Enterprises - 04 Aug 2026 - Rs 7,08,139',
    splits: [
      { saleDispatchId: 'cmrs6p33c00efcf2dwo64v71y', invoice: 'RVP/63/26-27', amount: 175279, tdsAmount: 0, shortageAmount: 0 },
      { saleDispatchId: 'cmrs6pr9n00eqcf2dtjugnrpg', invoice: 'RVP/64/26-27', amount: 173820, tdsAmount: 0, shortageAmount: 0 },
      { saleDispatchId: 'cmrs6s1sy00facf2di2wjq7ji', invoice: 'RVP/66/26-27', amount: 177990, tdsAmount: 0, shortageAmount: 0 },
      { saleDispatchId: 'cmrs6sjjq00fkcf2ddf02gqr2', invoice: 'RVP/67/26-27', amount: 181050, tdsAmount: 0, shortageAmount: 0 },
    ],
  },
];

const inr = (n: number) => `Rs ${Math.round(n).toLocaleString('en-IN')}`;

async function main() {
  const problems: string[] = [];
  const backup: unknown[] = [];

  for (const rep of REPAIRS) {
    const r = await prisma.receipt.findUnique({
      where: { id: rep.receiptId },
      include: { party: { select: { id: true, name: true } } },
    });
    if (!r) { problems.push(`${rep.label}: receipt not found (already fixed?)`); continue; }
    if (r.type !== 'BUYER') { problems.push(`${rep.label}: not a BUYER receipt`); continue; }
    if (r.saleDispatchId) { problems.push(`${rep.label}: already allocated to ${r.saleDispatchId}`); continue; }

    backup.push({
      id: r.id, date: r.date, amount: r.amount, tdsAmount: r.tdsAmount, shortageAmount: r.shortageAmount,
      type: r.type, partyId: r.partyId, saleDispatchId: r.saleDispatchId, payer: r.payer,
      reference: r.reference, description: r.description, journalEntryId: r.journalEntryId,
    });

    // Cash is a bank fact - the split may never change it.
    const cash = rep.splits.reduce((s, x) => s + x.amount, 0);
    if (cash !== Math.round(Number(r.amount))) {
      problems.push(`${rep.label}: split cash ${inr(cash)} != receipt ${inr(Number(r.amount))}`);
    }

    console.log(`\n${rep.label}`);
    console.log(`  original: cash ${inr(Number(r.amount))}, TDS ${inr(Number(r.tdsAmount ?? 0))}, shortage ${inr(Number(r.shortageAmount ?? 0))}`);

    for (const s of rep.splits) {
      const d = await prisma.saleDispatch.findUnique({
        where: { id: s.saleDispatchId },
        include: { saleOrder: { select: { ratePerKg: true, buyerId: true } } },
      });
      if (!d) { problems.push(`${rep.label}: dispatch ${s.invoice} not found`); continue; }
      if (d.invoiceNumber !== s.invoice) {
        problems.push(`${rep.label}: dispatch ${s.saleDispatchId} is ${d.invoiceNumber}, expected ${s.invoice}`);
      }
      if (d.saleOrder.buyerId !== r.partyId) {
        problems.push(`${rep.label}: ${s.invoice} belongs to another buyer`);
      }
      const already = await prisma.receipt.count({ where: { saleDispatchId: s.saleDispatchId } });
      if (already > 0) problems.push(`${rep.label}: ${s.invoice} already has ${already} linked receipt(s)`);

      const bill = Math.round(d.weightKg * Number(d.saleOrder.ratePerKg) + Number(d.gstAmount ?? 0));
      const cleared = s.amount + s.tdsAmount + s.shortageAmount;
      if (Math.abs(cleared - bill) > 1) {
        problems.push(`${rep.label}: ${s.invoice} clears ${inr(cleared)} against a ${inr(bill)} bill`);
      }
      console.log(
        `  -> ${s.invoice.padEnd(15)} cash ${inr(s.amount).padStart(14)}` +
        ` + TDS ${inr(s.tdsAmount).padStart(9)} + shortage ${inr(s.shortageAmount).padStart(9)}` +
        ` = ${inr(cleared)} / bill ${inr(bill)} ${Math.abs(cleared - bill) <= 1 ? 'SETTLED' : 'MISMATCH'}`,
      );
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `scripts/backup_on_account_receipts_${stamp}.json`;
  writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`\nBackup written: ${backupPath}`);

  if (problems.length) {
    console.log('\n=== BLOCKED ===');
    for (const p of problems) console.log(`  ${p}`);
    console.log('\nNothing written.');
    process.exitCode = 1;
    return;
  }

  if (!APPLY) {
    console.log('\nDRY RUN - all checks passed. Re-run with --apply to write.');
    return;
  }

  // Seven splits, each a create + a journal posting, against a remote Supabase
  // pooler - comfortably past Prisma's 5s interactive-transaction default.
  await prisma.$transaction(async (tx) => {
    for (const rep of REPAIRS) {
      const r = await tx.receipt.findUnique({ where: { id: rep.receiptId } });
      if (!r) throw new Error(`receipt ${rep.receiptId} vanished mid-run`);
      const party = r.partyId ? await tx.party.findUnique({ where: { id: r.partyId } }) : null;

      // Reverse the original. The journal entry cascades the receipt away; these
      // rows carry no dispatch id, so there are no TDS-/SHORTAGE- postings to undo.
      if (r.journalEntryId) await tx.journalEntry.delete({ where: { id: r.journalEntryId } });
      else await tx.receipt.delete({ where: { id: r.id } });

      for (const s of rep.splits) {
        const created = await tx.receipt.create({
          data: {
            date: r.date,
            amount: s.amount,
            tdsAmount: s.tdsAmount || null,
            shortageAmount: s.shortageAmount || null,
            type: r.type,
            partyId: r.partyId,
            saleDispatchId: s.saleDispatchId,
            payer: r.payer,
            reference: r.reference,
            description: r.description,
          },
        });
        await LedgerService.postReceipt(tx, created.id, {
          date: r.date,
          amount: s.amount,
          type: r.type,
          partyName: party?.name,
          payer: r.payer ?? undefined,
          reference: r.reference ?? undefined,
          description: r.description ?? undefined,
        });
        const je = await tx.journalEntry.findFirst({ where: { reference: `RECEIPT-${created.id}` } });
        if (je) await tx.receipt.update({ where: { id: created.id }, data: { journalEntryId: je.id } });
      }
    }
  }, { timeout: 180_000, maxWait: 30_000 });

  console.log(`\nApplied. ${REPAIRS.length} receipts rewritten as ${REPAIRS.reduce((s, r) => s + r.splits.length, 0)} invoice-linked rows.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
