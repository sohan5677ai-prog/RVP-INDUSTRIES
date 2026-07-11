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

    // Calculate current MAP for Black Seed
    const silos = await prisma.siloInventory.findMany({ where: { itemType: 'BLACK_SEED', location: 'RVP' } });
    const totalW = silos.reduce((s, x) => s + x.weightKg, 0);
    const totalV = silos.reduce((s, x) => s + Number(x.totalValue), 0);
    const map = totalW > 0 ? totalV / totalW : 45; // default 45 Rs if empty

    console.log(`Processing ${dispatches.length} PAPPU sales... MAP is ${map}`);

    let count = 0;
    for (const d of dispatches) {
        // Find existing journal entry
        const ref = `SALE-${d.id}`;
        let entry = await prisma.journalEntry.findFirst({
            where: { reference: ref },
            include: { lines: { include: { account: true } } }
        });

        // if the old code used saleOrderId for reference
        if (!entry) {
            entry = await prisma.journalEntry.findFirst({
                where: { reference: `SALE-${d.saleOrderId}` },
                include: { lines: { include: { account: true } } }
            });
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

        let baseAmount = 0;
        let gstAmount = 0;
        let cogsAmount = 0;
        let productionCostAmount = 0;

        if (entry) {
            const baseLine = entry.lines.find(l => l.account.code === '40010');
            baseAmount = Number(baseLine?.credit || 0);

            const gstLine = entry.lines.find(l => l.account.code === '20220');
            gstAmount = Number(gstLine?.credit || 0);

            const cogsLine = entry.lines.find(l => l.account.code === '50010' && l.costCenter !== 'PAPPU');
            cogsAmount = Number(cogsLine?.debit || 0);

            const prodLine = entry.lines.find(l => l.account.code === '50030');
            productionCostAmount = Number(prodLine?.credit || 0);
        } else {
            // Re-calculate if no entry
            baseAmount = d.weightKg * Number(d.saleOrder.ratePerKg);
            gstAmount = Math.round(d.weightKg * Number(d.saleOrder.ratePerKg) * 0.05 * 100) / 100;
            const remainingKg = Math.round(d.weightKg / 0.6);
            cogsAmount = Math.round(remainingKg * map * 100) / 100;
            // Get production cost
            productionCostAmount = Math.round(d.weightKg * 1.5 * 100) / 100; // rough approx 1.5/kg
        }

        await prisma.$transaction(async tx => {
            await tx.saleDispatch.update({
                where: { id: d.id },
                data: { freightCharge }
            });

            if (entry) {
                await tx.journalLine.deleteMany({ where: { journalEntryId: entry.id } });
                await tx.journalEntry.delete({ where: { id: entry.id } });
            }

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

            await tx.journalEntry.updateMany({
                where: { reference: `SALE-${d.id}` },
                data: { date: d.dispatchDate, createdAt: d.dispatchDate }
            });
        });
        
        count++;
    }
    console.log(`Done. Updated ${count} sales.`);
}
main().finally(() => prisma.$disconnect());
