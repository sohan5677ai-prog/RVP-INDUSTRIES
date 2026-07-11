import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function check() {
  const orders = await prisma.saleOrder.findMany({
    include: {
      buyer: true,
      broker: true,
      dispatches: true,
    },
    orderBy: { saleDate: 'asc' }
  });

  let pappuSum = 0;
  let huskSum = 0;

  for (const o of orders) {
    if (o.product === 'PAPPU') pappuSum += o.tonnageKg;
    if (o.product === 'HUSK') huskSum += o.tonnageKg;
    
    console.log(
      o.id,
      o.saleDate.toISOString().split('T')[0],
      o.product,
      o.buyer.name,
      `${o.tonnageKg}T`,
      o.broker?.name || 'NO BROKER',
      'Inv:', o.dispatches[0]?.invoiceNumber,
      'Lorry:', o.dispatches[0]?.vehicleNumber,
    );
  }
  
  console.log(`TOTAL PAPPU: ${pappuSum} kg`);
  console.log(`TOTAL HUSK: ${huskSum} kg`);
}

check().finally(() => prisma.$disconnect());
