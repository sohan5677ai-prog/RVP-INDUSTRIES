import { prisma } from './lib/prisma.js';

async function main() {
  const party = await prisma.party.findFirst({
    where: { name: { contains: 'DCS', mode: 'insensitive' } },
    include: {
      purchaseOrders: {
        include: {
          stockIns: {
            include: {
              purchase: {
                include: {
                  verification: true,
                  processing: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!party) {
    console.log('No party with DCS name found.');
    return;
  }

  console.log('--- Party Details ---');
  console.log(`ID: ${party.id}`);
  console.log(`Name: ${party.name}`);
  console.log(`Type: ${party.type}`);
  console.log(`Number of POs: ${party.purchaseOrders.length}`);

  for (const po of party.purchaseOrders) {
    console.log(`\n  --- PO ${po.poNumber} ---`);
    console.log(`  ID: ${po.id}`);
    console.log(`  PricePerKg: ${po.pricePerKg}`);
    console.log(`  TonnageKg: ${po.tonnageKg}`);
    console.log(`  Status: ${po.status}`);
    console.log(`  StockIns count: ${po.stockIns.length}`);

    for (const stockIn of po.stockIns) {
      console.log(`    --- StockIn ---`);
      console.log(`    ID: ${stockIn.id}`);
      console.log(`    Lorry: ${stockIn.lorryNumber}`);
      console.log(`    Invoice: ${stockIn.invoiceNumber}`);
      console.log(`    rvpKataKg: ${stockIn.rvpKataKg}`);
      console.log(`    Has Purchase: ${!!stockIn.purchase}`);
      if (stockIn.purchase) {
        const p = stockIn.purchase;
        console.log(`      Purchase ID: ${p.id}`);
        console.log(`      NetWeightKg: ${p.netWeightKg}`);
        console.log(`      Has Verification: ${!!p.verification}`);
        if (p.verification) {
          console.log(`        Verif PricePerKg: ${p.verification.pricePerKg}`);
          console.log(`        Verif FinalWeightKg: ${p.verification.finalWeightKg}`);
        }
        console.log(`      Has Processing: ${!!p.processing}`);
        if (p.processing) {
          console.log(`        Milled Weight: ${p.processing.blackWeightKg}`);
        }
      }
    }
  }
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
