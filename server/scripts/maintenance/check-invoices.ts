import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkInvoices() {
  const dispatches = await prisma.saleDispatch.findMany({
    where: { invoiceNumber: { not: null } },
    orderBy: { dispatchDate: 'desc' },
    take: 10,
    select: { id: true, invoiceNumber: true, invoiceSeq: true, invoiceFy: true, weightKg: true, status: true }
  });

  console.log("Latest invoices:");
  console.log(dispatches);
}

checkInvoices().catch(console.error).finally(() => prisma.$disconnect());
