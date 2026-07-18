import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function test() {
  const productWeights = await prisma.$queryRaw<{product: string, weightKg: number}[]>`
      SELECT so."product", SUM(sd."weightKg") as "weightKg"
      FROM "SaleOrder" so
      JOIN "SaleDispatch" sd ON sd."saleOrderId" = so.id
      GROUP BY so."product"
  `;
  console.log("Product Weights:", productWeights);
}

test().catch(console.error).finally(() => prisma.$disconnect());
