import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Updating all Purchase Orders to ARRIVED status...');
  const result = await prisma.purchaseOrder.updateMany({
    data: { status: 'ARRIVED' },
  });
  console.log(`Successfully updated ${result.count} Purchase Orders.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
