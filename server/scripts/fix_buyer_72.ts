import { prisma } from '../src/lib/prisma.js';

const ORDER_ID = 'cmr6p1nrj00vxs8l8n7mgzarq';
const RECEIPT_ID = 'cmritoaj40095s8vc7wsj94am';
const VINOD_ID = 'cmr6oy6a50000s8m0s7dmtngb';        // Vinod Salem (wrong)
const KERALA_ID = 'cmr6ow1aj000es8ww32srtk13';       // Kerala Trading Company (correct)

const APPLY = process.argv.includes('--apply');

async function main() {
  const order = await prisma.saleOrder.findUnique({ where: { id: ORDER_ID }, include: { buyer: true } });
  const receipt = await prisma.receipt.findUnique({ where: { id: RECEIPT_ID } });
  const kerala = await prisma.party.findUnique({ where: { id: KERALA_ID } });
  if (!order || !receipt || !kerala) { console.error('missing record'); return; }
  if (order.buyerId !== VINOD_ID || receipt.partyId !== VINOD_ID) {
    console.error('records are not both pointing at Vinod Salem; aborting for safety', { orderBuyer: order.buyerId, receiptParty: receipt.partyId });
    return;
  }
  console.log(`Order ${ORDER_ID} buyer: ${order.buyer?.name} -> ${kerala.name}`);
  console.log(`Receipt ${RECEIPT_ID} (₹${String(receipt.amount)}) party: Vinod Salem -> ${kerala.name}`);
  if (!APPLY) { console.log('\nDRY RUN. Re-run with --apply.'); return; }

  await prisma.$transaction([
    prisma.saleOrder.update({ where: { id: ORDER_ID }, data: { buyerId: KERALA_ID } }),
    prisma.receipt.update({ where: { id: RECEIPT_ID }, data: { partyId: KERALA_ID } }),
  ]);
  const remaining = {
    orders: await prisma.saleOrder.count({ where: { buyerId: VINOD_ID } }),
    receipts: await prisma.receipt.count({ where: { partyId: VINOD_ID } }),
    payments: await prisma.payment.count({ where: { partyId: VINOD_ID } }),
  };
  console.log('\nAPPLIED. Vinod Salem now references:', remaining);
}
main().finally(() => prisma.$disconnect());
