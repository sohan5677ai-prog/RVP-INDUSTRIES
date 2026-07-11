import { PrismaClient } from '@prisma/client';
import { LedgerService } from './src/services/ledger.service.js';
import { getHamaliRateFull, getCustomHamaliRates } from './src/controllers/settings.controller.js';
import { pappuLoadingHamali, customLoadingHamali } from './src/lib/calc.js';

const prisma = new PrismaClient();

async function run() {
  const customRates = await getCustomHamaliRates();
  const pl = await getHamaliRateFull('PAPPU_LOADING');

  console.log('Current Custom Hamali Rates:', customRates.map(c => c.label));

  const dispatches = await prisma.saleDispatch.findMany({
    where: { saleOrder: { product: 'PAPPU' } },
    include: { saleOrder: { include: { buyer: true } } },
  });

  console.log(`Found ${dispatches.length} PAPPU dispatches.`);

  let updatedCount = 0;

  for (const dispatch of dispatches) {
    const je = await prisma.journalEntry.findFirst({
      where: { reference: `SALE-${dispatch.id}` },
      include: { lines: { include: { account: true } } },
    });

    if (!je) {
      console.log(`Skipping SALE-${dispatch.id} (no journal entry found)`);
      continue;
    }

    let baseAmount = 0;
    let gstAmount = 0;
    let cogsAmount = 0;
    let productionCostAmount = 0;
    let freightAmount = 0;
    let freightRetention = 0;
    let freightKata = 0;

    for (const line of je.lines) {
      if (line.account.code === '40010') baseAmount = Number(line.credit);
      if (line.account.code === '20220') gstAmount = Number(line.credit);
      if (line.account.code === '50010') {
        if (line.costCenter === 'PAPPU') {
          productionCostAmount = Number(line.debit);
        } else {
          cogsAmount = Number(line.debit);
        }
      }
      if (line.account.code === '50050') freightAmount = Number(line.debit);
      if (line.account.code === '20255') freightRetention = Number(line.credit);
      if (line.account.code === '20270') freightKata = Number(line.credit);
    }

    const hasFreight = freightAmount > 0;
    let freightUnloadingHamali = 0;
    let hamaliCrewPayable = 0;
    let hamaliCompanyExpense = 0;
    let hamaliMargin = 0;

    if (hasFreight) {
      const lh = pappuLoadingHamali(dispatch.weightKg, false, pl.total, pl.lorry, pl.margin);
      freightUnloadingHamali = lh.lorry;
      hamaliCrewPayable = lh.crew;
      hamaliCompanyExpense = lh.company;
      hamaliMargin = lh.margin;

      for (const c of customRates) {
        const ch = customLoadingHamali(dispatch.weightKg, c.total, c.lorry, c.margin);
        freightUnloadingHamali += ch.lorry;
        hamaliCrewPayable += ch.crew;
        hamaliCompanyExpense += ch.company;
        hamaliMargin += ch.margin;
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.journalLine.deleteMany({ where: { journalEntryId: je.id } });
      await tx.journalEntry.delete({ where: { id: je.id } });

      await LedgerService.postSale(tx, dispatch.id, {
        buyerName: dispatch.saleOrder.buyer.name,
        product: dispatch.saleOrder.product,
        baseAmount,
        gstAmount,
        cogsAmount,
        cogsInventoryAccount: '10010',
        cogsCostCenter: 'Black Seed Pool',
        productionCostAmount,
        freightAmount,
        freightUnloadingHamali,
        freightKata,
        freightRetention,
        hamaliCrewPayable,
        hamaliCompanyExpense,
        hamaliMargin,
        weightKg: dispatch.weightKg,
      });
    });

    updatedCount++;
  }

  console.log(`Successfully updated ledger for ${updatedCount} Pappu dispatches.`);
}

run()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
