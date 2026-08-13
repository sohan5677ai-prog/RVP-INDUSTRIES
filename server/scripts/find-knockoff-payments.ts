// One-off audit: find the "payments" that were really knock-offs.
//
// Before the set-off feature existed, the only way to silence a purchase bill
// for a party we ALSO sell to was to record a supplier payment for it. That
// posts one leg only, so three things went wrong at once:
//   • the sale invoice stayed open forever on Sale Dues,
//   • the party ledger gained a receivable that will never be collected,
//   • the bank was credited for cash that never left.
//
// This script does not guess its way into deleting anything. It REPORTS, per
// dual-role party (one we both buy from and sell to), the supplier payments that
// carry the fingerprints of a knock-off, so a human can confirm each one. The
// fix for a confirmed row is: delete it here, then re-record it on Purchase Dues
// via "Set off vs Sales", which writes both legs.
//
//   npx tsx scripts/find-knockoff-payments.ts
//   npx tsx scripts/find-knockoff-payments.ts --delete=<paymentId>,<paymentId>
//
// --delete only ever touches the ids you name, writes a JSON backup first, and
// refuses anything that is already part of a set-off.
import { prisma } from '../src/lib/prisma.js';
import { writeFileSync } from 'node:fs';

const deleteArg = process.argv.find((a) => a.startsWith('--delete='));
const DELETE_IDS = deleteArg ? deleteArg.slice('--delete='.length).split(',').map((s) => s.trim()).filter(Boolean) : [];

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

async function main() {
  // ── Dual-role parties: a verified purchase AND a sale dispatch on record ──
  const [parties, purchases, dispatches, payments, receipts, dustPurchases] = await Promise.all([
    prisma.party.findMany({ where: { type: { not: 'HAMALI_TEAM' } } }),
    prisma.purchase.findMany({
      where: { verification: { isNot: null } },
      include: { verification: true, stockIn: { include: { purchaseOrder: { select: { partyId: true } } } } },
    }),
    prisma.saleDispatch.findMany({ include: { saleOrder: { select: { buyerId: true, ratePerKg: true } } } }),
    prisma.payment.findMany({ where: { type: 'SUPPLIER', partyId: { not: null } }, orderBy: { date: 'asc' } }),
    prisma.receipt.findMany({ where: { type: 'BUYER' } }),
    prisma.dustPurchase.findMany(),
  ]);

  if (DELETE_IDS.length > 0) {
    await deleteNamed(DELETE_IDS);
    return;
  }

  const purchaseTotalByParty = new Map<string, number>();
  for (const p of purchases) {
    const pid = p.stockIn?.purchaseOrder?.partyId;
    if (!pid) continue;
    purchaseTotalByParty.set(pid, (purchaseTotalByParty.get(pid) ?? 0) + Math.round(Number(p.verification!.totalAmount)));
  }
  for (const d of dustPurchases) {
    purchaseTotalByParty.set(d.partyId, (purchaseTotalByParty.get(d.partyId) ?? 0) + Math.round(Number(d.amount)));
  }

  const saleTotalByParty = new Map<string, number>();
  const settledByDispatch = new Map<string, number>();
  for (const r of receipts) {
    if (!r.saleDispatchId) continue;
    const amt = Number(r.amount) + Number(r.tdsAmount ?? 0) + Number(r.shortageAmount ?? 0);
    settledByDispatch.set(r.saleDispatchId, (settledByDispatch.get(r.saleDispatchId) ?? 0) + amt);
  }
  const openSaleByParty = new Map<string, number>();
  for (const d of dispatches) {
    const buyerId = d.saleOrder.buyerId;
    const total = Math.round(d.weightKg * Number(d.saleOrder.ratePerKg)) + Math.round(Number(d.gstAmount));
    saleTotalByParty.set(buyerId, (saleTotalByParty.get(buyerId) ?? 0) + total);
    const open = total - (settledByDispatch.get(d.id) ?? 0);
    if (open > 1) openSaleByParty.set(buyerId, (openSaleByParty.get(buyerId) ?? 0) + open);
  }

  const dualRole = parties.filter(
    (p) => (purchaseTotalByParty.get(p.id) ?? 0) > 0 && (saleTotalByParty.get(p.id) ?? 0) > 0
  );

  if (dualRole.length === 0) {
    console.log('No party has both purchases and sales on record - nothing to audit.');
    return;
  }

  console.log(`\nParties we both BUY from and SELL to: ${dualRole.length}\n`);
  console.log('A supplier payment is flagged when it has no proof screenshot AND no bank');
  console.log('reference - the shape of a book entry rather than a transfer. Flagging is a');
  console.log('prompt to check, never proof: confirm each against the bank statement.\n');

  let flaggedCount = 0;
  for (const party of dualRole.sort((a, b) => a.name.localeCompare(b.name))) {
    const openSale = Math.round(openSaleByParty.get(party.id) ?? 0);
    const partyPayments = payments.filter((p) => p.partyId === party.id && !p.setOffId);

    // A knock-off recorded as a payment leaves no bank trail: no proof
    // screenshot, and no UTR / cheque number in the reference.
    const flagged = partyPayments.filter((p) => {
      const ref = (p.reference ?? '').trim();
      const looksLikeMode = /^(RTGS|NEFT|IMPS|UPI|Cheque|Cash|Manual)$/i.test(ref);
      return !p.screenshotUrl && (ref === '' || looksLikeMode);
    });

    console.log('─'.repeat(78));
    console.log(`${party.name}  (${party.type})`);
    console.log(
      `  purchases ${inr(purchaseTotalByParty.get(party.id) ?? 0)}` +
        ` · sales ${inr(saleTotalByParty.get(party.id) ?? 0)}` +
        ` · sale invoices still open ${inr(openSale)}`
    );
    if (openSale > 0) {
      console.log('  ⚠ open sale invoices alongside supplier payments - the classic symptom.');
    }
    if (flagged.length === 0) {
      console.log('  no payments without a bank trail.');
      continue;
    }
    console.log(`  ${flagged.length} payment(s) with no bank trail:`);
    for (const p of flagged) {
      flaggedCount++;
      console.log(
        `    ${p.date.toISOString().slice(0, 10)}  ${inr(Number(p.amount)).padStart(14)}` +
          `  ref=${p.reference ?? '-'}  id=${p.id}`
      );
      if (p.description) console.log(`        "${p.description}"`);
    }
  }

  console.log('─'.repeat(78));
  console.log(`\n${flaggedCount} payment(s) flagged for review.`);
  console.log('For each one you confirm was a knock-off, not a transfer:');
  console.log('  1. npx tsx scripts/find-knockoff-payments.ts --delete=<id>');
  console.log('  2. Purchase Dues → "Set off vs Sales" → re-record it against the sale invoice.\n');
}

/** Delete only the payments named on the command line, after backing them up. */
async function deleteNamed(ids: string[]) {
  const rows = await prisma.payment.findMany({ where: { id: { in: ids } }, include: { party: true } });
  const missing = ids.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length) {
    console.error(`Not found: ${missing.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const partOfSetOff = rows.filter((r) => r.setOffId);
  if (partOfSetOff.length) {
    console.error(
      `Refusing: ${partOfSetOff.map((r) => r.id).join(', ')} are set-off legs already. ` +
        'Reverse the set-off itself instead - both sides must come out together.'
    );
    process.exitCode = 1;
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `scripts/backup_knockoff_payments_${stamp}.json`;
  writeFileSync(backup, JSON.stringify(rows, null, 2));
  console.log(`Backup written to ${backup}`);

  for (const p of rows) {
    // Same order deletePayment uses: the journal entry cascades the payment away
    // when one is attached, otherwise the row goes directly.
    await prisma.$transaction(async (tx) => {
      if (p.journalEntryId) await tx.journalEntry.delete({ where: { id: p.journalEntryId } });
      else await tx.payment.delete({ where: { id: p.id } });
    });
    console.log(`Deleted ${p.id} - ${p.party?.name ?? 'unknown'} ${inr(Number(p.amount))}`);
  }
  console.log('\nNow re-record each as a set-off: Purchase Dues → "Set off vs Sales".');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
