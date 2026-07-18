// One-off backfill: no-GST URP (Direct Inward) arrivals used to get a throwaway
// invoice number like "URP-2026-07-17-482". They should instead mirror the
// arrival's own PO number (e.g. "URP/05/26-27"), same as new arrivals now do
// (see stockIn.controller.ts createUrpStockIn). GST'd URP arrivals are left
// alone - they carry a real supplier invoice number.
import { prisma } from '../src/lib/prisma.js';
import { writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');

async function main() {
  const rows = await prisma.stockIn.findMany({
    where: {
      purchaseOrder: { createdBy: 'URP_DIRECT', hasGst: false },
    },
    include: { purchaseOrder: true },
  });

  const changes = rows.filter((r) => r.invoiceNumber !== r.purchaseOrder.poNumber);

  if (changes.length === 0) {
    console.log('Nothing to do - all no-GST URP stock-ins already mirror their PO number.');
    return;
  }

  const backup = changes.map((r) => ({ id: r.id, invoiceNumber: r.invoiceNumber }));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `scripts/backup_urp_invoice_numbers_${stamp}.json`;
  writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`Backup written: ${backupPath}\n`);

  console.log('=== CHANGES ===');
  for (const r of changes) {
    console.log(`${r.invoiceNumber}  ->  ${r.purchaseOrder.poNumber}   [lorry ${r.lorryNumber}, ${r.arrivalDate.toISOString().slice(0, 10)}]`);
  }
  console.log(`\n${changes.length} stock-in(s) to update.`);

  if (!APPLY) {
    console.log('\nDRY RUN. Re-run with --apply to write.');
    return;
  }

  await prisma.$transaction(
    changes.map((r) => prisma.stockIn.update({
      where: { id: r.id },
      data: { invoiceNumber: r.purchaseOrder.poNumber },
    })),
  );
  console.log('\nAPPLIED.');
}

main().finally(() => prisma.$disconnect());
