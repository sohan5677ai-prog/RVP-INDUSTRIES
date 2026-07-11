import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const idsToDelete = [
    'cmr11kfa80007s8ognx9wqsa2', // My insert Inv 35
    'cmr11kfb1000as8ogi373howq', // My insert Inv 40
    'cmr11kfc4000ds8og4ikifgdi', // My insert Inv 68
    'cmr11kfct000gs8ogt6ggiifd', // My insert Inv 69
    'cmr11kff6000qs8og9nyml9ca', // My insert Inv 57
    'cmr11kfdi000js8og31e76u5r', // My insert Inv 71
    'cmqyvu5np001is880o08wh28l', // Orig dup RVP/16
    'cmqyvu5uj0022s880s4qjb0zp', // Orig dup RVP/23
    'cmqyvu604002ms880st25wml9', // Orig dup RVP/31
    'cmqyvu6ph0052s880n9gjvm5y', // Orig dup RVP/62
    'cmqyvu6gk004as8805hhtqj8x', // Orig dup Inv 53 (06-03)
    'cmr0yjv5n002ns8u8ae0smrq5', // Orig dup Inv 67 (06-20)
  ];

  for (const id of idsToDelete) {
    // Delete dispatches first
    await prisma.saleDispatch.deleteMany({
      where: { saleOrderId: id }
    });
    // Delete order
    await prisma.saleOrder.deleteMany({
      where: { id }
    });
    console.log(`Deleted order ${id}`);
  }

  // Check total tonnage again
  const orders = await prisma.saleOrder.findMany();
  let pappuSum = 0;
  let huskSum = 0;
  for (const o of orders) {
    if (o.product === 'PAPPU') pappuSum += o.tonnageKg;
    if (o.product === 'HUSK') huskSum += o.tonnageKg;
  }
  
  console.log(`NEW TOTAL PAPPU: ${pappuSum} kg`);
  console.log(`NEW TOTAL HUSK: ${huskSum} kg`);
}

main().finally(() => prisma.$disconnect());
