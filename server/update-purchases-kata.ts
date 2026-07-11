import { PrismaClient } from '@prisma/client';
import { LedgerService } from './src/services/ledger.service.js';
import { calcKataFee } from './src/lib/calc.js';

const prisma = new PrismaClient();

async function run() {
  const purchases = await prisma.purchase.findMany({
    include: {
      stockIn: { include: { purchaseOrder: { include: { party: true } } } },
    }
  });

  let updatedCount = 0;

  for (const p of purchases) {
    if (!p.stockIn) continue;

    const newKataFee = calcKataFee(p.netWeightKg);
    const oldKataFee = Number(p.kataFee);

    // Always re-run the ledger to ensure it perfectly matches.
    // Wait, let's just update the purchase row first.
    await prisma.purchase.update({
      where: { id: p.id },
      data: { kataFee: newKataFee }
    });

    // Re-create the journal entry for the purchase
    const je = await prisma.journalEntry.findFirst({
      where: { reference: `PUR-${p.id}` }
    });

    if (je) {
      await prisma.$transaction(async (tx) => {
        await tx.journalLine.deleteMany({ where: { journalEntryId: je.id } });
        await tx.journalEntry.delete({ where: { id: je.id } });

        // LedgerService.postPurchase needs a bunch of fields from the purchase row.
        // We can just use the fields from `p`.
        await LedgerService.postPurchase(tx, p.id, {
          supplierName: p.stockIn!.purchaseOrder.party.name,
          product: p.stockIn!.purchaseOrder.product,
          baseAmount: Number(p.baseAmount),
          gstAmount: Number(p.gstAmount),
          weightKg: p.netWeightKg,
          freightAmount: Number(p.freightCharge),
          freightUnloadingHamali: Number(p.hamaliCharge),
          freightKata: newKataFee,
          freightToll: Number(p.tollCharge),
          freightAdvance: Number(p.advancePaid),
          shortageAmount: Number(p.shortageAmount),
        });
      });
    }

    updatedCount++;
  }

  console.log(`Successfully updated ${updatedCount} purchases.`);
}

run().finally(() => prisma.$disconnect());
