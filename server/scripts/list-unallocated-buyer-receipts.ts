// READ-ONLY audit: buyer receipts that were never stamped with a saleDispatchId.
//
// Settlement across the app is invoice-based ONLY - a shipment is cleared purely
// by the receipts carrying its own dispatch id (settledByDispatch/isDispatchPaid).
// So a buyer receipt with no saleDispatchId is money that landed in the party
// ledger but cleared no invoice: the Sale Dues page still calls that invoice
// Unpaid, and the ledger statement prints the receipt with a blank Invoice cell.
//
// This script lists every such receipt, plus each affected buyer's open
// shipments, so they can be allocated (Receipts page -> "Link invoice").
import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';

function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

async function main() {
  const orphans = await prisma.receipt.findMany({
    where: { type: 'BUYER', saleDispatchId: null },
    include: { party: { select: { id: true, name: true } } },
    orderBy: { date: 'desc' },
  });

  console.log(`=== UNALLOCATED BUYER RECEIPTS: ${orphans.length} ===`);
  if (orphans.length === 0) {
    console.log('None - every buyer receipt clears a specific invoice.');
    return;
  }

  let total = 0;
  for (const r of orphans) {
    total += Number(r.amount) + Number(r.tdsAmount ?? 0) + Number(r.shortageAmount ?? 0);
    console.log(
      `${r.date.toISOString().slice(0, 10)}  ${(r.party?.name ?? '(no party)').padEnd(32)}` +
      `  ${inr(Number(r.amount)).padStart(15)}` +
      `  tds ${inr(Number(r.tdsAmount ?? 0))}  shortage ${inr(Number(r.shortageAmount ?? 0))}` +
      `  ref=${r.reference ?? '-'}  id=${r.id}`,
    );
  }
  console.log(`\nTotal sitting on account (cash + TDS + shortage): ${inr(total)}`);

  // Open shipments for each affected buyer - the candidates to allocate against.
  const buyerIds = [...new Set(orphans.map((r) => r.partyId).filter(Boolean))] as string[];
  const orders = await prisma.saleOrder.findMany({
    where: { buyerId: { in: buyerIds } },
    include: { buyer: { select: { name: true } }, dispatches: { include: { receipts: true } } },
  });

  console.log('\n=== OPEN SHIPMENTS FOR THOSE BUYERS ===');
  for (const o of orders) {
    for (const d of o.dispatches) {
      const bill = Math.round(d.weightKg * Number(o.ratePerKg) + Number(d.gstAmount ?? 0));
      const cleared = d.receipts.reduce(
        (s, r) => s + Number(r.amount) + Number(r.tdsAmount ?? 0) + Number(r.shortageAmount ?? 0),
        0,
      );
      if (cleared >= bill - 1) continue; // already settled
      console.log(
        `${d.dispatchDate.toISOString().slice(0, 10)}  ${(o.buyer?.name ?? '').padEnd(32)}` +
        `  ${(d.invoiceNumber ?? '(no invoice)').padEnd(16)}` +
        `  bill ${inr(bill).padStart(15)}  cleared ${inr(cleared).padStart(15)}` +
        `  open ${inr(bill - cleared).padStart(15)}  id=${d.id}`,
      );
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
