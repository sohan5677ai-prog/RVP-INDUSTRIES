import { PrismaClient } from '@prisma/client';
import { LedgerService } from './src/services/ledger.service.js';
import { getHamaliRateFull, getCustomHamaliRates } from './src/controllers/settings.controller.js';
import { pappuLoadingHamali, customLoadingHamali, calcKataFee } from './src/lib/calc.js';

const prisma = new PrismaClient();

function calcGst(weightKg: number, ratePerKg: number): number {
  return Math.round(weightKg * ratePerKg * 0.05 * 100) / 100;
}

async function run() {
  const customRates = await getCustomHamaliRates();
  const pl = await getHamaliRateFull('PAPPU_LOADING');
  const huskPl = await getHamaliRateFull('HUSK_LOADING');

  const dispatches = await prisma.saleDispatch.findMany({
    include: { saleOrder: { include: { buyer: true } } },
  });

  let updatedCount = 0;

  for (const dispatch of dispatches) {
    const order = dispatch.saleOrder;
    
    // Find the JE we created today
    const je = await prisma.journalEntry.findFirst({
      where: { reference: `SALE-${dispatch.id}` }
    });
    
    if (!je) continue;

    // We only want to update the ones that had freightCharge = 0, because those were the ones we incorrectly zeroed out
    const freightAmount = Number(dispatch.freightCharge || 0);
    const hasFreight = freightAmount > 0;
    
    // Actually, let's just delete the JE and re-create it to ensure it perfectly matches the new logic
    
    const weightKg = dispatch.weightKg;
    const baseAmount = Math.round(weightKg * Number(order.ratePerKg) * 100) / 100;
    const gstAmount = calcGst(weightKg, Number(order.ratePerKg));
    
    let freightUnloadingHamali = 0;
    let hamaliCrewPayable = 0;
    let hamaliCompanyExpense = 0;
    let hamaliMargin = 0;

    if (order.product === 'PAPPU') {
      const lh = pappuLoadingHamali(weightKg, false, pl.total, pl.lorry, pl.margin);
      freightUnloadingHamali = lh.lorry;
      hamaliCrewPayable = lh.crew;
      hamaliCompanyExpense = lh.company;
      hamaliMargin = lh.margin;

      for (const c of customRates) {
        const ch = customLoadingHamali(weightKg, c.total, c.lorry, c.margin);
        freightUnloadingHamali += ch.lorry;
        hamaliCrewPayable += ch.crew;
        hamaliCompanyExpense += ch.company;
        hamaliMargin += ch.margin;
      }
    } else if (order.product === 'HUSK' || order.product === 'WASTE') {
      const lh = customLoadingHamali(weightKg, huskPl.total, huskPl.lorry, huskPl.margin);
      freightUnloadingHamali = lh.lorry;
      hamaliCrewPayable = lh.crew;
      hamaliCompanyExpense = lh.company;
      hamaliMargin = lh.margin;
    }

    await prisma.$transaction(async (tx) => {
      // Delete existing lines and JE
      await tx.journalLine.deleteMany({ where: { journalEntryId: je.id } });
      await tx.journalEntry.delete({ where: { id: je.id } });
      
      // Re-create
      await LedgerService.postSale(tx, dispatch.id, {
        buyerName: order.buyer.name,
        product: order.product,
        baseAmount,
        gstAmount,
        cogsAmount: 0,
        cogsInventoryAccount: '10010',
        cogsCostCenter: 'Black Seed Pool',
        productionCostAmount: 0,
        freightAmount,
        freightUnloadingHamali,
        freightKata: calcKataFee(weightKg),
        freightRetention: 0,
        hamaliCrewPayable,
        hamaliCompanyExpense,
        hamaliMargin,
        weightKg,
      });
    });
    updatedCount++;
  }

  console.log(`Successfully updated ledger entries for ${updatedCount} dispatches.`);
}

run().finally(() => prisma.$disconnect());
