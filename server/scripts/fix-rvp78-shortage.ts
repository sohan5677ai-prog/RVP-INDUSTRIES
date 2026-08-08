// One-off: clear the 90 kg delivery shortage on RVP/78/26-27 (Spectrum, PAPPU).
//
// The receipt against this shipment was undone, which correctly removed the
// receipt and its SHORTAGE-<dispatch> ledger posting. But the shortage on this
// shipment came from the Buyer's Kata entered at Mark Delivered (29,910 vs
// 30,000 kg), which lives on the dispatch itself and is deliberately left alone
// by a receipt undo. This script does what re-submitting Mark Delivered with a
// 30,000 kg kata would do, so nothing can re-derive the shortage later:
//
//   buyerKataKg 29,910 -> 30,000
//   shortageKg  90     -> 0
//   creditNoteAmount   -> 0
//   internalWeightProfitAmount recomputed off internalWeightKg 29,800
//
//   node --import tsx scripts/fix-rvp78-shortage.ts          (dry run)
//   node --import tsx scripts/fix-rvp78-shortage.ts --apply
import { writeFileSync } from 'node:fs';
import { prisma } from '../src/lib/prisma.js';

const APPLY = process.argv.includes('--apply');
const INVOICE = 'RVP/78/26-27';

async function main() {
  const dispatch = await prisma.saleDispatch.findFirst({
    where: { invoiceNumber: INVOICE },
    include: { saleOrder: { include: { buyer: true } }, receipts: true },
  });
  if (!dispatch) {
    console.log(`No dispatch found for ${INVOICE}`);
    return;
  }
  if (dispatch.receipts.length > 0) {
    console.log(`ABORT: ${dispatch.receipts.length} receipt(s) still attached - undo those first.`);
    return;
  }

  const rate = Number(dispatch.saleOrder.ratePerKg);
  const newKataKg = dispatch.weightKg;
  const profitWeightKg = dispatch.internalWeightKg ? newKataKg - dispatch.internalWeightKg : 0;
  const newProfit =
    dispatch.saleOrder.product === 'PAPPU' && profitWeightKg > 0 ? profitWeightKg * rate : null;

  const before = {
    id: dispatch.id,
    invoiceNumber: dispatch.invoiceNumber,
    buyer: dispatch.saleOrder.buyer.name,
    weightKg: dispatch.weightKg,
    internalWeightKg: dispatch.internalWeightKg,
    buyerKataKg: dispatch.buyerKataKg,
    shortageKg: dispatch.shortageKg,
    creditNoteAmount: dispatch.creditNoteAmount?.toString() ?? null,
    internalWeightProfitAmount: dispatch.internalWeightProfitAmount?.toString() ?? null,
  };
  console.log('BEFORE:', before);
  console.log('AFTER :', {
    buyerKataKg: newKataKg,
    shortageKg: 0,
    creditNoteAmount: 0,
    internalWeightProfitAmount: newProfit,
  });

  if (!APPLY) {
    console.log('\nDry run - pass --apply to write.');
    return;
  }

  const backup = `scripts/backup_rvp78_shortage_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(backup, JSON.stringify(before, null, 2));
  console.log(`Backup written to ${backup}`);

  await prisma.saleDispatch.update({
    where: { id: dispatch.id },
    data: {
      buyerKataKg: newKataKg,
      shortageKg: 0,
      creditNoteAmount: 0,
      internalWeightProfitAmount: newProfit,
    },
  });
  console.log('Updated.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
