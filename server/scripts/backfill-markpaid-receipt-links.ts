// One-off backfill: older "Mark Paid" buyer receipts were created without a
// saleDispatchId, and their TDS / shortage deductions were only stored on the
// dispatch (tdsAmount / creditNoteAmount), never on the receipt. As a result
// settledByDispatch() couldn't tell those shipments were paid, so the sales
// page kept showing "Mark Paid" and the Sale Orders "Paid" badge never lit up.
//
// markDispatchPaid now links the receipt and copies the deductions onto it
// (sale.controller.ts). This backfill retro-fits the same shape onto the old
// receipts so historical shipments read as Paid.
//
// A Mark-Paid receipt is identified by: type BUYER, no saleDispatchId, and a
// description of the form "Payment for Invoice <token>", where <token> is the
// dispatch's invoiceNumber (or, if it had none at the time, the dispatch id).
//
// Dry run by default; pass --apply to write. A JSON backup of the prior receipt
// state is saved either way (when there are changes).
import { prisma } from '../src/lib/prisma.js';
import { writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const PREFIX = 'Payment for Invoice ';

async function main() {
  const candidates = await prisma.receipt.findMany({
    where: {
      type: 'BUYER',
      saleDispatchId: null,
      description: { startsWith: PREFIX },
    },
  });

  if (candidates.length === 0) {
    console.log('Nothing to do - no unlinked Mark-Paid buyer receipts found.');
    return;
  }

  // Load every dispatch once, indexed by invoice number and by id, with the
  // parent order's buyer + rate so we can sanity-check the match and report
  // whether the link makes the shipment read as fully paid.
  const dispatches = await prisma.saleDispatch.findMany({
    include: { saleOrder: { select: { buyerId: true, ratePerKg: true } } },
  });
  const byInvoice = new Map<string, typeof dispatches>();
  const byId = new Map<string, (typeof dispatches)[number]>();
  for (const d of dispatches) {
    byId.set(d.id, d);
    if (d.invoiceNumber) {
      const list = byInvoice.get(d.invoiceNumber) ?? [];
      list.push(d);
      byInvoice.set(d.invoiceNumber, list);
    }
  }

  // Dispatches already claimed by a linked receipt must not be re-linked.
  const alreadyLinked = new Set(
    (await prisma.receipt.findMany({ where: { saleDispatchId: { not: null } }, select: { saleDispatchId: true } }))
      .map((r) => r.saleDispatchId as string),
  );

  type Plan = {
    receiptId: string;
    dispatchId: string;
    invoiceLabel: string;
    setTds: number | null;
    setShortage: number | null;
    cleared: number;
    invoiceTotal: number;
    willReadPaid: boolean;
  };
  const plans: Plan[] = [];
  const skipped: { receiptId: string; token: string; reason: string }[] = [];

  for (const r of candidates) {
    const token = (r.description ?? '').slice(PREFIX.length).trim();
    if (!token) {
      skipped.push({ receiptId: r.id, token: '', reason: 'empty invoice token' });
      continue;
    }

    // Prefer an invoice-number match; fall back to a dispatch-id match (used
    // when the shipment had no invoice number when it was marked paid).
    let match: (typeof dispatches)[number] | undefined;
    const invMatches = (byInvoice.get(token) ?? []).filter(
      (d) => !r.partyId || d.saleOrder.buyerId === r.partyId,
    );
    if (invMatches.length === 1) {
      match = invMatches[0];
    } else if (invMatches.length > 1) {
      skipped.push({ receiptId: r.id, token, reason: `ambiguous - ${invMatches.length} dispatches share invoice ${token}` });
      continue;
    } else {
      const byIdMatch = byId.get(token);
      if (byIdMatch && (!r.partyId || byIdMatch.saleOrder.buyerId === r.partyId)) match = byIdMatch;
    }

    if (!match) {
      skipped.push({ receiptId: r.id, token, reason: 'no matching dispatch' });
      continue;
    }
    if (alreadyLinked.has(match.id)) {
      skipped.push({ receiptId: r.id, token, reason: `dispatch ${match.id} already has a linked receipt` });
      continue;
    }

    const dTds = Number(match.tdsAmount ?? 0);
    const dShort = Number(match.creditNoteAmount ?? 0);
    const setTds = r.tdsAmount == null && dTds > 0 ? dTds : null;
    const setShortage = r.shortageAmount == null && dShort > 0 ? dShort : null;

    const cleared = Number(r.amount) + Number(r.tdsAmount ?? setTds ?? 0) + Number(r.shortageAmount ?? setShortage ?? 0);
    const invoiceTotal = Math.round(match.weightKg * Number(match.saleOrder.ratePerKg) + Number(match.gstAmount));

    plans.push({
      receiptId: r.id,
      dispatchId: match.id,
      invoiceLabel: match.invoiceNumber ?? match.id,
      setTds,
      setShortage,
      cleared,
      invoiceTotal,
      willReadPaid: cleared > 0 && cleared >= invoiceTotal - 0.01,
    });
    // Claim the dispatch so two candidate receipts can't both grab it.
    alreadyLinked.add(match.id);
  }

  console.log('=== LINK PLAN ===');
  for (const p of plans) {
    const extras = [
      p.setTds != null ? `TDS ${p.setTds}` : null,
      p.setShortage != null ? `shortage ${p.setShortage}` : null,
    ].filter(Boolean).join(', ');
    console.log(
      `receipt ${p.receiptId} -> dispatch ${p.dispatchId} [inv ${p.invoiceLabel}]` +
      `  cleared ₹${p.cleared} / ₹${p.invoiceTotal}  ${p.willReadPaid ? 'PAID' : 'still short'}` +
      (extras ? `  (+${extras})` : ''),
    );
  }
  console.log(`\n${plans.length} receipt(s) to link, ${plans.filter((p) => p.willReadPaid).length} will read as Paid.`);

  if (skipped.length) {
    console.log('\n=== SKIPPED ===');
    for (const s of skipped) console.log(`receipt ${s.receiptId} [token "${s.token}"] - ${s.reason}`);
  }

  if (plans.length === 0) {
    console.log('\nNo linkable receipts.');
    return;
  }

  // Backup the receipts we are about to touch, before writing.
  const touched = new Set(plans.map((p) => p.receiptId));
  const backup = candidates
    .filter((r) => touched.has(r.id))
    .map((r) => ({ id: r.id, saleDispatchId: r.saleDispatchId, tdsAmount: r.tdsAmount, shortageAmount: r.shortageAmount }));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `scripts/backup_markpaid_receipt_links_${stamp}.json`;
  writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`\nBackup written: ${backupPath}`);

  if (!APPLY) {
    console.log('\nDRY RUN. Re-run with --apply to write.');
    return;
  }

  await prisma.$transaction(
    plans.map((p) => prisma.receipt.update({
      where: { id: p.receiptId },
      data: {
        saleDispatchId: p.dispatchId,
        ...(p.setTds != null ? { tdsAmount: p.setTds } : {}),
        ...(p.setShortage != null ? { shortageAmount: p.setShortage } : {}),
      },
    })),
  );
  console.log(`\nApplied. Linked ${plans.length} receipt(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
