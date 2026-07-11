import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const group = await prisma.accountGroup.findFirst({ where: { name: 'Current Liabilities' } });
  
  await prisma.account.upsert({
    where: { code: '20260' },
    update: { name: 'KNM Transport Payable', type: 'LIABILITY', groupId: group?.id },
    create: { code: '20260', name: 'KNM Transport Payable', type: 'LIABILITY', groupId: group?.id }
  });
  console.log('Added 20260 KNM Transport Payable');
}
main().catch(console.error).finally(() => prisma.$disconnect());
