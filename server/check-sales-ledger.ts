import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function run() {
  const dispatches = await prisma.saleDispatch.findMany({
    include: { saleOrder: true }
  });
  
  let withJe = 0;
  let withoutJe = 0;
  
  for (const d of dispatches) {
    const je = await prisma.journalEntry.findFirst({
      where: { reference: `SALE-${d.id}` }
    });
    if (je) withJe++;
    else withoutJe++;
  }
  
  console.log(`Dispatches with Journal Entry: ${withJe}`);
  console.log(`Dispatches without Journal Entry: ${withoutJe}`);
}

run().finally(() => prisma.$disconnect());
