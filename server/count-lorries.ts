import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function countLorries() {
  const allPurchases = await prisma.purchase.count();
  const filteredPurchases = await prisma.purchase.count({
    where: { kataFee: { gt: 0 } }
  });

  const dispatches = await prisma.saleDispatch.count();

  console.log(`All Purchases: ${allPurchases}`);
  console.log(`Purchases with Kata Fee > 0: ${filteredPurchases}`);
  console.log(`Sales Dispatches: ${dispatches}`);
  console.log(`Total Lorries (All Purchases + Dispatches): ${allPurchases + dispatches}`);
  console.log(`Total Lorries (Filtered Purchases + Dispatches): ${filteredPurchases + dispatches}`);
}

countLorries().finally(() => prisma.$disconnect());
