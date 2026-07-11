import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const partiesToDelete = ["Vimal Industries", "Colourtex", "Enegix - Soham Agro"];
  const brokerName = "Jithu Bhai";
  const targetDateStr = "2026-06-25";

  // Find the parties
  const parties = await prisma.party.findMany({
    where: {
      name: { in: partiesToDelete }
    }
  });
  
  const partyIds = parties.map(p => p.id);

  // Find the broker
  const broker = await prisma.broker.findFirst({
    where: { name: brokerName }
  });

  if (!broker) {
    console.error(`Broker ${brokerName} not found`);
    return;
  }

  // Find the SaleOrders
  // In Javascript/Prisma, comparing dates by string might be tricky, so let's match by partyId and brokerId
  const orders = await prisma.saleOrder.findMany({
    where: {
      buyerId: { in: partyIds },
      brokerId: broker.id,
      // We could also filter by date, but let's just get the ones matching these parties and broker.
      // Assuming these are the ones the user wants to delete. We can double check the date.
      saleDate: {
        gte: new Date("2026-06-24T00:00:00.000Z"),
        lt: new Date("2026-06-27T00:00:00.000Z"),
      }
    },
    include: {
      dispatches: true,
      buyer: true
    }
  });

  console.log(`Found ${orders.length} orders to delete.`);

  for (const order of orders) {
    console.log(`Deleting order for ${order.buyer.name} (Tonnage: ${order.tonnageKg / 1000}t) with ${order.dispatches.length} dispatches...`);
    
    // 1. Delete all dispatches for this order
    await prisma.saleDispatch.deleteMany({
      where: {
        saleOrderId: order.id
      }
    });

    // 2. Delete the order
    await prisma.saleOrder.delete({
      where: {
        id: order.id
      }
    });
    
    console.log(`Deleted order for ${order.buyer.name}.`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
