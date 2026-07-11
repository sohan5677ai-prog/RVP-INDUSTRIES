const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const party = await prisma.party.findFirst({ where: { name: { contains: 'Tejus Mysore' } } });
  const purchases = await prisma.purchase.findMany({
    where: { stockIn: { purchaseOrder: { partyId: party.id } } },
    include: { verification: true, stockIn: true }
  });
  console.log(JSON.stringify(purchases.map(p => ({
    id: p.id,
    createdAt: p.createdAt,
    arrivalDate: p.stockIn?.arrivalDate,
    total: p.verification?.totalAmount
  })), null, 2));
}
main().finally(() => prisma.$disconnect());
