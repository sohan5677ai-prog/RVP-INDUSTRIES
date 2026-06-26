import { prisma } from './lib/prisma.js';
import { LedgerService } from './services/ledger.service.js';
import { InventoryService } from './services/inventory.service.js';

const salesData = [
  { date: '2026-04-06', party: 'Chhaya Industries', tons: 25.00, rate: 48.20 },
  { date: '2026-04-08', party: 'Adinath', tons: 25.00, rate: 48.70 },
  { date: '2026-04-10', party: 'Adinath', tons: 25.00, rate: 48.70 },
  { date: '2026-04-12', party: 'Srinivasa Agro', tons: 30.00, rate: 49.00 },
  { date: '2026-04-13', party: 'Chhaya Industries', tons: 35.00, rate: 49.45 },
  { date: '2026-04-14', party: 'Chhaya Industries', tons: 25.00, rate: 48.70 },
  { date: '2026-04-16', party: 'Srinivasa Agro', tons: 30.00, rate: 49.00 },
  { date: '2026-04-17', party: 'Vimal Industries', tons: 25.00, rate: 50.55 },
  { date: '2026-05-05', party: 'Enegix', tons: 25.00, rate: 48.30 },
  { date: '2026-05-06', party: 'Enegix', tons: 25.00, rate: 48.30 },
  { date: '2026-05-07', party: 'Enegix', tons: 30.00, rate: 48.30 },
  { date: '2026-05-08', party: 'Enegix - Soham Agro', tons: 30.00, rate: 48.30 },
  { date: '2026-05-09', party: 'Enegix - Soham Agro', tons: 30.00, rate: 48.30 },
  { date: '2026-05-10', party: 'Enegix - Soham Agro', tons: 35.00, rate: 48.30 },
  { date: '2026-05-10', party: 'Enegix', tons: 25.00, rate: 48.30 },
  { date: '2026-05-12', party: 'Soham Agro', tons: 35.00, rate: 49.30 },
  { date: '2026-05-13', party: 'Soham Agro', tons: 35.00, rate: 49.30 },
  { date: '2026-05-13', party: 'Colourtex', tons: 25.00, rate: 48.80 },
  { date: '2026-05-15', party: 'Enegix', tons: 30.00, rate: 49.30 },
  { date: '2026-05-16', party: 'Enegix', tons: 30.00, rate: 49.30 },
  { date: '2026-05-17', party: 'Colourtex', tons: 30.00, rate: 49.30 },
  { date: '2026-05-18', party: 'Soham Agro', tons: 35.00, rate: 49.30 },
  { date: '2026-05-19', party: 'Spectrum', tons: 25.00, rate: 48.80 },
  { date: '2026-05-19', party: 'Colourtex', tons: 30.00, rate: 49.30 },
  { date: '2026-05-20', party: 'Soham Agro', tons: 35.00, rate: 49.30 },
  { date: '2026-05-21', party: 'Spectrum', tons: 25.00, rate: 48.80 },
  { date: '2026-05-25', party: 'Adinath', tons: 25.00, rate: 47.50 },
  { date: '2026-05-27', party: 'Soham Agro', tons: 30.00, rate: 47.80 },
  { date: '2026-05-30', party: 'Colourtex', tons: 30.00, rate: 49.30 },
  { date: '2026-05-30', party: 'Colourtex', tons: 25.00, rate: 48.80 },
  { date: '2026-05-30', party: 'Chhaya Industries', tons: 25.00, rate: 46.70 },
  { date: '2026-05-31', party: 'Colourtex', tons: 35.00, rate: 49.30 },
  { date: '2026-05-31', party: 'Colourtex', tons: 25.00, rate: 49.30 },
  { date: '2026-06-02', party: 'Colourtex', tons: 35.00, rate: 49.30 },
  { date: '2026-06-02', party: 'Chhaya Industries', tons: 30.00, rate: 46.70 },
  { date: '2026-06-02', party: 'Spectrum', tons: 35.00, rate: 46.80 },
  { date: '2026-06-03', party: 'Chhaya Industries', tons: 30.00, rate: 46.70 },
  { date: '2026-06-04', party: 'Chhaya Industries', tons: 30.00, rate: 46.70 },
  { date: '2026-06-05', party: 'Colourtex', tons: 30.00, rate: 46.80 },
  { date: '2026-06-07', party: 'Colourtex', tons: 30.00, rate: 46.80 },
  { date: '2026-06-09', party: 'Colourtex', tons: 30.00, rate: 46.80 },
  { date: '2026-06-11', party: 'Colourtex', tons: 30.00, rate: 46.80 },
  { date: '2026-06-12', party: 'Chhaya Industries', tons: 30.00, rate: 45.70 },
  { date: '2026-06-13', party: 'Colourtex', tons: 30.00, rate: 46.80 }
];

export async function importHistoricalSales() {
  console.log('Starting historical sales import...');
  
  for (const row of salesData) {
    let party = await prisma.party.findFirst({ where: { name: row.party, type: 'BUYER' } });
    if (!party) {
      party = await prisma.party.create({
        data: { name: row.party, type: 'BUYER' }
      });
      console.log(`Created buyer: ${row.party}`);
    }

    const weightKg = Math.round(row.tons * 1000);
    const ratePerKg = row.rate;
    const baseAmount = weightKg * ratePerKg;
    const gstAmount = Math.round(baseAmount * 0.05 * 100) / 100;
    
    // Create the SaleOrder
    const order = await prisma.saleOrder.create({
      data: {
        saleDate: new Date(row.date),
        product: 'PAPPU',
        buyerId: party.id,
        tonnageKg: weightKg,
        ratePerKg: ratePerKg,
        gstAmount,
        status: 'DISPATCHED',
      },
      include: { buyer: true }
    });
    
    console.log(`Created order ${order.id} for ${row.party}`);

    await prisma.$transaction(async (tx) => {
      // Consume Inventory
      const cogsAmount = await InventoryService.consumeBlackSeedForSale(tx, weightKg);
      
      const dispatch = await tx.saleDispatch.create({
        data: {
          saleOrderId: order.id,
          weightKg,
          gstAmount,
          status: 'DISPATCHED',
          dispatchDate: new Date(row.date),
        }
      });
      
      const productionCostPerKg = await InventoryService.getProductionCostPerKg();
      const productionCostAmount = Math.round(weightKg * productionCostPerKg * 100) / 100;

      await LedgerService.postSale(tx, dispatch.id, {
        buyerName: order.buyer.name,
        product: 'PAPPU',
        baseAmount,
        gstAmount,
        cogsAmount,
        productionCostAmount,
        freightAmount: 0,
        freightUnloadingHamali: 0,
        freightKata: 0,
        freightRetention: 0,
        hamaliCrewPayable: 0,
        hamaliCompanyExpense: 0,
        hamaliMargin: 0,
        weightKg,
        brokerageAmount: 0,
      });
    });
  }
  
  const fs = await import("fs");
  fs.writeFileSync("scratch-output.txt", "SUCCESSFULLY IMPORTED 44 HISTORICAL SALES");
  console.log('Done importing sales.');
}
