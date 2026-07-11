import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const orders = await prisma.saleOrder.findMany({
    include: {
      buyer: true,
      dispatches: true
    }
  });

  const grouped = new Map<string, any[]>();
  for (const o of orders) {
    const lorry = o.dispatches[0]?.vehicleNumber;
    if (lorry && lorry !== 'null' && lorry !== 'undefined') {
      if (!grouped.has(lorry)) grouped.set(lorry, []);
      grouped.get(lorry)!.push(o);
    }
  }

  let dupesFound = 0;
  for (const [lorry, list] of grouped.entries()) {
    if (list.length > 1) {
      console.log(`\nDUPLICATE LORRY: ${lorry} (${list.length} times)`);
      for (const o of list) {
        console.log(`  - ${o.id} | ${o.createdAt.toISOString()} | ${o.buyer.name} | ${o.tonnageKg}kg | Inv: ${o.dispatches[0]?.invoiceNumber}`);
      }
      dupesFound++;
    }
  }
  
  if (dupesFound === 0) console.log('No duplicate lorries found.');
}

main().finally(() => prisma.$disconnect());
