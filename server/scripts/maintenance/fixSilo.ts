import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const purchases = await prisma.purchase.findMany({ include: { verification: true, stockIn: { include: { purchaseOrder: true } } } });
  const transfers = await prisma.stockTransfer.findMany();
  const sales = await prisma.saleOrder.findMany({ where: { product: 'PAPPU' }, include: { dispatches: true } });
  
  let locKg = { 'RVP': 0, 'PGR COLD': 0, 'Murugan': 0, 'KNM Multi': 0 };
  let locVal = { 'RVP': 0, 'PGR COLD': 0, 'Murugan': 0, 'KNM Multi': 0 };
  
  for (const p of purchases) {
    const loc = p.stockIn.loadingLocation;
    const kg = p.verification ? p.verification.finalWeightKg : p.netWeightKg;
    const basePrice = Number(p.stockIn.purchaseOrder.pricePerKg);
    const hamali = Number(p.hamaliCharge) / 2;
    const freight = Number(p.freightCharge);
    const val = p.verification ? Number(p.verification.totalAmount) + hamali + freight : kg * basePrice + hamali + freight;
    if(locKg[loc] !== undefined) { locKg[loc] += kg; locVal[loc] += val; }
  }
  
  for (const t of transfers) {
    const cost = Number(t.seedCostMoved) + Number(t.interestCharge);
    if(locKg[t.fromLocation] !== undefined) { locKg[t.fromLocation] -= t.weightKg; locVal[t.fromLocation] -= cost; }
    if(locKg[t.toLocation] !== undefined) { locKg[t.toLocation] += t.weightKg; locVal[t.toLocation] += cost; }
  }
  
  let pappuCommittedKg = 0;
  for (const so of sales) {
    const dispatched = so.dispatches.reduce((s, d) => s + d.weightKg, 0);
    pappuCommittedKg += Math.max(so.tonnageKg, dispatched);
  }
  const seedConsumed = Math.round(pappuCommittedKg / 0.6);
  locKg['RVP'] -= seedConsumed;
  // approximate value depletion for RVP
  if (locKg['RVP'] > 0 && locVal['RVP'] > 0) {
     const map = locVal['RVP'] / (locKg['RVP'] + seedConsumed);
     locVal['RVP'] -= seedConsumed * map;
  }
  
  for (const loc of Object.keys(locKg)) {
    let kg = locKg[loc];
    let val = locVal[loc];
    if (kg < 0) { kg = 0; val = 0; }
    
    const existing = await prisma.siloInventory.findFirst({ where: { itemType: 'BLACK_SEED', location: loc } });
    if (existing) {
       await prisma.siloInventory.update({ where: { id: existing.id }, data: { weightKg: kg, totalValue: val } });
    } else {
       await prisma.siloInventory.create({ data: { itemType: 'BLACK_SEED', location: loc, weightKg: kg, totalValue: val } });
    }
  }
  console.log('Fixed SiloInventory!', locKg);
}
main().catch(console.error).finally(() => prisma.$disconnect());

