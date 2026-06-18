import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting transaction cleanup...');

  await prisma.$transaction([
    // Delete pricing & dispatch details
    prisma.pappuPrice.deleteMany(),
    prisma.saleDispatch.deleteMany(),
    prisma.saleOrder.deleteMany(),

    // Delete processing batches
    prisma.processing.deleteMany(),

    // Delete purchase transactional models
    prisma.weightVerification.deleteMany(),
    prisma.purchase.deleteMany(),
    prisma.stockIn.deleteMany(),
    prisma.purchaseOrder.deleteMany(),

    // Delete journal postings
    prisma.journalLine.deleteMany(),
    prisma.journalEntry.deleteMany(),

    // Reset inventory levels to 0
    prisma.siloInventory.deleteMany(),
  ]);

  console.log('Transaction cleanup successful. All transactional tables cleared and SiloInventory reset.');
}

main()
  .catch((e) => {
    console.error('Error during transaction cleanup:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
