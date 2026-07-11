import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  // Ensure RVP broker exists
  let rvpBroker = await prisma.broker.findFirst({
    where: { name: 'RVP' }
  });

  if (!rvpBroker) {
    rvpBroker = await prisma.broker.create({
      data: {
        name: 'RVP',
        phone: '',
      }
    });
    console.log('Created RVP broker.');
  }

  // Update all sale orders without a broker
  const updated = await prisma.saleOrder.updateMany({
    where: { brokerId: null },
    data: { brokerId: rvpBroker.id }
  });

  console.log(`Updated ${updated.count} orders to have RVP as broker.`);
  await prisma.$disconnect();
}

run();
