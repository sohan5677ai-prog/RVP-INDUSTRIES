import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Verification helper: create (or clean) a PAPPU sale so the Stock by Price
// band depletion can be checked. Run `tsx prisma/testPappuSale.ts --clean` to
// remove it again and return the dataset to purchases-only.
const CLEAN = process.argv.includes('--clean');
const BUYER = '__TEST_PAPPU_BUYER__';

async function main() {
  // Always clear any prior test sale first.
  const buyer = await prisma.party.findFirst({ where: { name: BUYER } });
  if (buyer) {
    const orders = await prisma.saleOrder.findMany({ where: { buyerId: buyer.id }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    if (ids.length) await prisma.saleDispatch.deleteMany({ where: { saleOrderId: { in: ids } } });
    await prisma.saleOrder.deleteMany({ where: { buyerId: buyer.id } });
    await prisma.party.delete({ where: { id: buyer.id } });
  }
  if (CLEAN) {
    console.log('✓ Test pappu sale removed.');
    return;
  }

  const b = await prisma.party.create({ data: { name: BUYER, type: 'BUYER' } });
  const order = await prisma.saleOrder.create({
    data: {
      saleDate: new Date(),
      product: 'PAPPU',
      buyerId: b.id,
      tonnageKg: 6000,
      ratePerKg: 48, // ceiling = 48 × 0.6 = ₹28.80/kg seed
    },
  });
  await prisma.saleDispatch.create({
    data: { saleOrderId: order.id, weightKg: 6000, dispatchDate: new Date() },
  });

  console.log('✓ Created PAPPU sale: 6.00 MT @ ₹48/kg (ceiling ₹28.80/kg seed).');
  console.log('  Expect: ₹28.80 band depletes 10.00 MT seed (6 MT pappu ÷ 0.6) top-first.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
