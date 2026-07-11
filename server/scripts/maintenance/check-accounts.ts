import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function run() {
  const accounts = await prisma.account.findMany();
  console.log(accounts.map(a => a.name));
}

run().finally(() => prisma.$disconnect());
