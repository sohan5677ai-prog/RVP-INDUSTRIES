import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const parties = await prisma.party.findMany({
    where: { name: { contains: 'viba', mode: 'insensitive' } },
    include: {
      saleOrders: {
        include: {
          dispatches: true
        }
      }
    }
  });
  console.log('--- PARTIES ---');
  console.log(JSON.stringify(parties, null, 2));

  const freightRates = await prisma.freightRate.findMany();
  console.log('--- FREIGHT RATES ---');
  console.log(JSON.stringify(freightRates, null, 2));

  // Search for any sale order or party with Namakal / Namakkal or Viba
  const namakalOrders = await prisma.saleOrder.findMany({
    where: {
      OR: [
        { destination: { contains: 'namak', mode: 'insensitive' } },
        { buyer: { name: { contains: 'viba', mode: 'insensitive' } } }
      ]
    },
    include: {
      buyer: true,
      dispatches: true
    }
  });
  console.log('--- NAMAKAL / VIBA ORDERS ---');
  console.log(JSON.stringify(namakalOrders, null, 2));

  // Also check journal entries related to these dispatches / orders
  const journalEntries = await prisma.journalEntry.findMany({
    where: {
      OR: [
        { description: { contains: 'viba', mode: 'insensitive' } },
        { description: { contains: 'namak', mode: 'insensitive' } }
      ]
    },
    include: { lines: true }
  });
  console.log('--- JOURNAL ENTRIES ---');
  console.log(JSON.stringify(journalEntries, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
