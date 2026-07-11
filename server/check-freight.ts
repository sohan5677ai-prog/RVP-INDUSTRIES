import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function run() {
  const d = await prisma.saleDispatch.findFirst({ where: { freightCharge: { gt: 0 } } });
  console.log('Dispatches with freight:', d ? 'YES' : 'NO');
}

run().finally(() => prisma.$disconnect());
