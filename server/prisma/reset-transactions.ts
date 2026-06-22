import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting transaction cleanup...');

  await prisma.$transaction([
    // Delete sale orders
    prisma.saleOrder.deleteMany(),

    // Delete stock transfers + processing batches
    prisma.stockTransfer.deleteMany(),
    prisma.processing.deleteMany(),

    // Delete bank loans + repayments (repayments cascade, but be explicit)
    prisma.loanRepayment.deleteMany(),
    prisma.bankLoan.deleteMany(),

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
