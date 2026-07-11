import { PrismaClient } from '@prisma/client';
import { LedgerService } from './src/services/ledger.service.js';
import { getHamaliRateFull, getCustomHamaliRates } from './src/controllers/settings.controller.js';
import { pappuLoadingHamali, customLoadingHamali } from './src/lib/calc.js';
function calcGst(weightKg: number, ratePerKg: number): number {
  return Math.round(weightKg * ratePerKg * 0.05 * 100) / 100;
}
const prisma = new PrismaClient();

async function run() {
  const customRates = await getCustomHamaliRates();
  const pl = await getHamaliRateFull('PAPPU_LOADING');
  const huskPl = await getHamaliRateFull('HUSK_LOADING');

  const dispatches = await prisma.saleDispatch.findMany({
    include: { saleOrder: { include: { buyer: true } } },
  });

  let createdCount = 0;

  for (const dispatch of dispatches) {
    const order = dispatch.saleOrder;
    
    const je = await prisma.journalEntry.findFirst({
      where: { reference: `SALE-${dispatch.id}` }
    });
    
    // If it already has a journal entry, we'll skip creating a new one (we already updated the 1 valid pappu dispatch)
    if (je) continue;

    // It has no journal entry! Let's create one.
    const weightKg = dispatch.weightKg;
    const baseAmount = Math.round(weightKg * Number(order.ratePerKg) * 100) / 100;
    const gstAmount = calcGst(weightKg, Number(order.ratePerKg));
    const freightAmount = Number(dispatch.freightCharge || 0);
    const hasFreight = freightAmount > 0;
    
    let freightUnloadingHamali = 0;
    let hamaliCrewPayable = 0;
    let hamaliCompanyExpense = 0;
    let hamaliMargin = 0;

    if (order.product === 'PAPPU') {
      const lh = pappuLoadingHamali(weightKg, false, pl.total, pl.lorry, pl.margin);
      if (hasFreight) {
        freightUnloadingHamali = lh.lorry;
        hamaliCrewPayable = lh.crew;
        hamaliCompanyExpense = lh.company;
        hamaliMargin = lh.margin;
      } else {
        hamaliCompanyExpense = lh.company;
        hamaliCrewPayable = lh.company;
      }

      for (const c of customRates) {
        const ch = customLoadingHamali(weightKg, c.total, c.lorry, c.margin);
        if (hasFreight) {
          freightUnloadingHamali += ch.lorry;
          hamaliCrewPayable += ch.crew;
          hamaliCompanyExpense += ch.company;
          hamaliMargin += ch.margin;
        } else {
          hamaliCompanyExpense += ch.company;
          hamaliCrewPayable += ch.company;
        }
      }
    } else if (order.product === 'HUSK' || order.product === 'WASTE') {
      const lh = customLoadingHamali(weightKg, huskPl.total, huskPl.lorry, huskPl.margin);
      if (hasFreight) {
        freightUnloadingHamali = lh.lorry;
        hamaliCrewPayable = lh.crew;
        hamaliCompanyExpense = lh.company;
        hamaliMargin = lh.margin;
      } else {
        hamaliCompanyExpense = lh.company;
        hamaliCrewPayable = lh.company;
      }
    }

    // Since we are NOT depleting inventory now (as it wasn't done on import), 
    // we use a rough assumed COGS so P&L isn't completely crazy, OR we just use 0.
    // Let's use 0 for now so we don't mess up the inventory accounts artificially.
    // Wait, the ledger postSale requires a cogsAmount. We'll set it to 0.
    
    await prisma.$transaction(async (tx) => {
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
        freightKata: 0,
        freightRetention: 0,
        hamaliCrewPayable,
        hamaliCompanyExpense,
        hamaliMargin,
        weightKg,
      });
    });
    createdCount++;
  }

  console.log(`Successfully created missing ledger entries for ${createdCount} dispatches.`);
}

run().finally(() => prisma.$disconnect());
