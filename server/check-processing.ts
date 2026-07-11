import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const processings = await prisma.processing.findMany({
    orderBy: { processDate: 'asc' }
  });

  let totalBlackSeedIn = 0;
  let totalPappuOut = 0;

  for (const p of processings) {
    totalBlackSeedIn += p.blackSeedWeightKg;
    totalPappuOut += p.pappuWeightKg;
  }

  console.log(`TOTAL BLACK SEED PROCESSED: ${totalBlackSeedIn} kg`);
  console.log(`TOTAL PAPPU PRODUCED: ${totalPappuOut} kg`);

  const purchases = await prisma.purchaseOrder.findMany({
    where: { status: { not: 'VOID' } },
    include: { stockIns: true }
  });

  let purchasedBlackSeed = 0;
  for (const p of purchases) {
    if (p.product === 'BLACK_SEED') {
      for (const s of p.stockIns) {
        purchasedBlackSeed += s.billingWeightKg;
      }
    }
  }

  console.log(`TOTAL BLACK SEED PURCHASED: ${purchasedBlackSeed} kg`);
}

main().finally(() => prisma.$disconnect());
