import { PrismaClient } from '@prisma/client';
import { calcKataFee, pappuLoadingHamali } from './src/lib/calc.js';
import { LedgerService } from './src/services/ledger.service.js';
const prisma = new PrismaClient();

async function main() {
    const dispatches = await prisma.saleDispatch.findMany({
        where: { saleOrder: { product: 'PAPPU' } },
        include: { saleOrder: { include: { buyer: true } } }
    });

    const rates = await prisma.freightRate.findMany();
    const company = await prisma.companyProfile.findFirst();
    const retention = Number(company?.freightRetentionPerTrip ?? 3000);
    const hamaliRate = await prisma.hamaliRate.findUnique({ where: { key: 'PAPPU_LOADING' } });

    console.log(`Processing ${dispatches.length} PAPPU sales...`);

    let count = 0;
    for (const d of dispatches) {
        if (Number(d.freightCharge) > 0) {
            console.log(`Skipping SALE-${d.saleOrderId}, freight already set.`);
            continue;
        }

        const destination = d.saleOrder.buyer.destination;
        const rate = rates.find(r => r.destination === destination)?.ratePerTonne ?? 0;
        const freightCharge = Math.round((d.weightKg / 1000) * Number(rate) * 100) / 100;

        const lh = pappuLoadingHamali(d.weightKg, false, Number(hamaliRate?.totalRatePerTonne || 220), Number(hamaliRate?.lorrySharePerTonne || 80), Number(hamaliRate?.companyMarginPerTonne || 10));
        
        const hasFreight = freightCharge > 0;
        const freightUnloadingHamali = hasFreight ? lh.lorry : 0;
        const hamaliCrewPayable = hasFreight ? lh.crew : lh.company;
        const hamaliCompanyExpense = lh.company;
        const hamaliMargin = hasFreight ? lh.margin : 0;
        const freightKata = calcKataFee(d.weightKg);
        const freightRetention = hasFreight ? retention : 0;

        const ref = `SALE-${d.saleOrderId}`;
        const entry = await prisma.journalEntry.findFirst({
            where: { reference: ref },
            include: { lines: { include: { account: true } } }
        });

        if (!entry) {
            console.log(`No entry found for ${ref}, skipping.`);
            continue;
        }

        const baseLine = entry.lines.find(l => l.account.code === '40010');
        const baseAmount = Number(baseLine?.credit || 0);

        const gstLine = entry.lines.find(l => l.account.code === '20220');
        const gstAmount = Number(gstLine?.credit || 0);

        // find COGS line that is not for factory overhead (50030)
        // Wait, COGS is 50010. 
        // 50010 for inventory has costCenter='Black Seed Pool' or null.
        // 50010 for production cost has costCenter='PAPPU'.
        const cogsLine = entry.lines.find(l => l.account.code === '50010' && l.costCenter !== 'PAPPU');
        const cogsAmount = Number(cogsLine?.debit || 0);

        const prodLine = entry.lines.find(l => l.account.code === '50030');
        const productionCostAmount = Number(prodLine?.credit || 0);

        await prisma.$transaction(async tx => {
            await tx.saleDispatch.update({
                where: { id: d.id },
                data: { freightCharge }
            });

            await tx.journalLine.deleteMany({ where: { journalEntryId: entry.id } });
            await tx.journalEntry.delete({ where: { id: entry.id } });

            await LedgerService.postSale(tx, d.id, {
                buyerName: d.saleOrder.buyer.name,
                product: 'PAPPU',
                baseAmount,
                gstAmount,
                cogsAmount,
                productionCostAmount,
                freightAmount: freightCharge,
                freightUnloadingHamali,
                freightKata,
                freightRetention,
                hamaliCrewPayable,
                hamaliCompanyExpense,
                hamaliMargin,
                weightKg: d.weightKg
            });
        });
        
        count++;
    }
    console.log(`Done. Updated ${count} sales.`);
}
main().finally(() => prisma.$disconnect());
