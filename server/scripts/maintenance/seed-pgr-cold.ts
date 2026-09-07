import { prisma } from '../../src/lib/prisma.js';
import { clearCache } from '../../src/lib/cache.js';
import { companyHamaliShare } from '../../src/lib/calc.js';

async function main() {
  console.log('--- Step 1: Clean trailing tabs / whitespace on all StockIn lorry numbers ---');
  const allStockIns = await prisma.stockIn.findMany();
  let trimmedCount = 0;
  for (const s of allStockIns) {
    if (s.lorryNumber && s.lorryNumber !== s.lorryNumber.trim()) {
      await prisma.stockIn.update({
        where: { id: s.id },
        data: { lorryNumber: s.lorryNumber.trim() }
      });
      trimmedCount++;
    }
  }
  console.log(`Trimmed ${trimmedCount} StockIn lorry numbers.`);

  console.log('\n--- Step 2: Seed fresh black seed stock for PGR COLD ---');
  // Two fresh deliveries for PGR COLD to give it active, transferable stock
  const seedLots = [
    {
      partyName: 'KTV Karimangalam',
      date: new Date('2026-08-15T00:00:00.000Z'),
      lorry: 'AP39UQ4204',
      invoice: 'PGR-2026-01',
      netKg: 26500,
      price: 28.00,
    },
    {
      partyName: 'Bismillah Traders',
      date: new Date('2026-08-20T00:00:00.000Z'),
      lorry: 'TN52C3595',
      invoice: 'PGR-2026-02',
      netKg: 28500,
      price: 28.00,
    }
  ];

  let totalAddedKg = 0;
  let totalAddedValue = 0;

  for (const lot of seedLots) {
    let party = await prisma.party.findFirst({
      where: { name: lot.partyName }
    });
    if (!party) {
      party = await prisma.party.create({
        data: {
          name: lot.partyName,
          type: 'SUPPLIER',
          commodities: ['BLACK_SEED']
        }
      });
      console.log(`Created party: ${party.name}`);
    }

    const kg = lot.netKg;
    const amount = kg * lot.price;
    const hamaliCharge = (kg / 1000) * 80;
    const ourHamali = companyHamaliShare(hamaliCharge);

    // Create PurchaseOrder
    const po = await prisma.purchaseOrder.create({
      data: {
        poDate: lot.date,
        partyId: party.id,
        pricePerKg: lot.price,
        priceType: 'DELIVERY',
        tonnageKg: kg,
        actualTonnageKg: kg,
        status: 'COMPLETED',
        createdBy: 'Admin Script'
      }
    });
    console.log(`Created PO ${po.poNumber || po.id} for ${lot.partyName}`);

    // Create StockIn
    const stockIn = await prisma.stockIn.create({
      data: {
        purchaseOrderId: po.id,
        arrivalDate: lot.date,
        lorryNumber: lot.lorry,
        invoiceNumber: lot.invoice,
        billingWeightKg: kg,
        partyKataKg: kg,
        rvpFirstWeightKg: kg,
        rvpSecondWeightKg: 0,
        rvpKataKg: kg,
        invoiceFileUrl: '',
        loadingLocation: 'PGR COLD'
      }
    });
    console.log(`Created StockIn ${stockIn.id} at PGR COLD (${kg} kg)`);

    // Create Purchase
    const purchase = await prisma.purchase.create({
      data: {
        stockInId: stockIn.id,
        netWeightKg: kg,
        hamaliRate: 80,
        hamaliCharge,
        kataFee: 0,
        freightCharge: 0
      }
    });
    console.log(`Created Purchase ${purchase.id}`);

    // Create WeightVerification
    const weightVerification = await prisma.weightVerification.create({
      data: {
        purchaseId: purchase.id,
        billingWeightKg: kg,
        partyKataKg: kg,
        rvpKataKg: kg,
        referenceKg: kg,
        diffKg: 0,
        exempt: true,
        finalWeightKg: kg,
        pricePerKg: lot.price,
        totalAmount: amount,
        selfVehicleHamali: 0,
        selfVehicleKata: 0
      }
    });
    console.log(`Created WeightVerification ${weightVerification.id}`);

    totalAddedKg += kg;
    totalAddedValue += amount + ourHamali;
  }

  console.log(`\nTotal seeded stock: ${totalAddedKg} kg, value: ₹${totalAddedValue}`);

  console.log('\n--- Step 3: Synchronize SiloInventory for PGR COLD ---');
  // Sync PGR COLD siloInventory so weightKg matches actual physical stock exactly
  const allPgrPurchases = await prisma.purchase.findMany({
    where: { stockIn: { loadingLocation: 'PGR COLD' } },
    select: { netWeightKg: true, freightCharge: true, hamaliCharge: true, verification: true, stockIn: { select: { purchaseOrder: { select: { pricePerKg: true } } } } }
  });
  const totalPgrReceivedKg = allPgrPurchases.reduce((s, p) => s + p.netWeightKg, 0);

  const pgrTransfersOut = await prisma.stockTransfer.aggregate({
    where: { fromLocation: 'PGR COLD' },
    _sum: { weightKg: true, seedCostMoved: true }
  });
  const totalPgrOutKg = pgrTransfersOut._sum.weightKg ?? 0;
  const totalPgrOutCost = Number(pgrTransfersOut._sum.seedCostMoved ?? 0);

  const currentPhysicalKg = totalPgrReceivedKg - totalPgrOutKg;

  // Compute remaining value of lots in PGR COLD
  let totalPgrGrossValue = 0;
  for (const p of allPgrPurchases) {
    const price = p.verification ? Number(p.verification.pricePerKg) : Number(p.stockIn.purchaseOrder.pricePerKg);
    const ourHamali = companyHamaliShare(Number(p.hamaliCharge));
    const freight = Number(p.freightCharge);
    totalPgrGrossValue += (p.netWeightKg * price) + ourHamali + freight;
  }
  const currentPhysicalValue = Math.max(0, totalPgrGrossValue - totalPgrOutCost);

  let pgrSilo = await prisma.siloInventory.findFirst({
    where: { itemType: 'BLACK_SEED', location: 'PGR COLD' }
  });

  if (!pgrSilo) {
    pgrSilo = await prisma.siloInventory.create({
      data: {
        itemType: 'BLACK_SEED',
        location: 'PGR COLD',
        weightKg: currentPhysicalKg,
        totalValue: currentPhysicalValue
      }
    });
  } else {
    await prisma.siloInventory.update({
      where: { id: pgrSilo.id },
      data: {
        weightKg: currentPhysicalKg,
        totalValue: currentPhysicalValue
      }
    });
  }

  console.log(`PGR COLD SiloInventory updated: ${currentPhysicalKg} kg, value: ₹${currentPhysicalValue.toFixed(2)}`);

  clearCache('pappu_order_margins');
  console.log('Cache cleared. Done!');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
