const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const party = await prisma.party.findFirst({
    where: { name: { contains: 'Tejus Mysore' } }
  });
  if (!party) return console.log('Party not found');
  
  const purchases = await prisma.purchase.findMany({
    where: { stockIn: { purchaseOrder: { partyId: party.id } } },
    include: { verification: true, stockIn: true }
  });
  
  const payments = await prisma.payment.findMany({
    where: { partyId: party.id, type: 'SUPPLIER' }
  });
  
  console.log('Purchases:', JSON.stringify(purchases.map(p => ({
    id: p.id,
    date: p.createdAt,
    total: p.verification?.totalAmount,
    inv: p.stockIn?.invoiceNumber
  })), null, 2));
  
  console.log('Payments:', JSON.stringify(payments.map(p => ({
    id: p.id,
    date: p.date,
    amount: p.amount
  })), null, 2));
}

main().finally(() => prisma.$disconnect());
