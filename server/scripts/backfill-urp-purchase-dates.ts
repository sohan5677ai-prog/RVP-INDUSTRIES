// One-off backfill: autoRecordUrpPurchase never set Purchase.purchaseDate, so it
// defaulted to now() (the record-creation date) instead of the Stock In arrival
// date. Realign every URP_DIRECT purchase's date to its StockIn.arrivalDate.
import { prisma } from '../src/lib/prisma.js';
import { writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');

async function main() {
  const purchases = await prisma.purchase.findMany({
    where: { stockIn: { purchaseOrder: { createdBy: 'URP_DIRECT' } } },
    include: { stockIn: true },
  });

  const changes = purchases.filter(
    (p) => p.purchaseDate.toISOString().slice(0, 10) !== p.stockIn.arrivalDate.toISOString().slice(0, 10),
  );

  if (changes.length === 0) {
    console.log('Nothing to do - all URP purchase dates already match their arrival date.');
    return;
  }

  const backup = changes.map((p) => ({ id: p.id, purchaseDate: p.purchaseDate }));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `scripts/backup_urp_purchase_dates_${stamp}.json`;
  writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`Backup written: ${backupPath}\n`);

  console.log('=== CHANGES ===');
  for (const p of changes) {
    console.log(`${p.purchaseDate.toISOString().slice(0, 10)}  ->  ${p.stockIn.arrivalDate.toISOString().slice(0, 10)}   [lorry ${p.stockIn.lorryNumber}, invoice ${p.stockIn.invoiceNumber}]`);
  }
  console.log(`\n${changes.length} purchase(s) to update.`);

  if (!APPLY) {
    console.log('\nDRY RUN. Re-run with --apply to write.');
    return;
  }

  await prisma.$transaction(
    changes.map((p) => prisma.purchase.update({
      where: { id: p.id },
      data: { purchaseDate: p.stockIn.arrivalDate },
    })),
  );
  console.log('\nAPPLIED.');
}

main().finally(() => prisma.$disconnect());
