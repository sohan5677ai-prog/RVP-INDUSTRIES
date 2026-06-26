import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.account.upsert({
    where: { code: '40040' },
    update: { name: 'Internal Weight Profit', type: 'REVENUE' },
    create: { code: '40040', name: 'Internal Weight Profit', type: 'REVENUE' },
  });
  console.log('Account 40040 created/updated');
}

main().catch(console.error).finally(() => prisma.$disconnect());
