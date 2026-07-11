import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const deletedDispatches = await prisma.saleDispatch.deleteMany({
    where: { saleOrder: { product: 'HUSK' } }
  });
  console.log(`Deleted ${deletedDispatches.count} dispatches.`);
  const deletedOrders = await prisma.saleOrder.deleteMany({
    where: { product: 'HUSK' }
  });
  console.log(`Deleted ${deletedOrders.count} orders.`);
}
main().finally(() => prisma.$disconnect());
