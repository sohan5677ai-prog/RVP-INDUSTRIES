import { PrismaClient } from '@prisma/client'; 
const prisma = new PrismaClient(); 
async function main() { 
  const sales = await prisma.saleOrder.findMany({ include: { buyer: true, broker: true }}); 
  console.log('Total sales count:', sales.length); 
  const totalTonnage = sales.reduce((sum, s) => sum + s.tonnageKg, 0); 
  console.log('Total sales tonnage:', totalTonnage / 1000, 'MT'); 
  const productTonnage = sales.reduce((acc, s) => {
    acc[s.product] = (acc[s.product] || 0) + s.tonnageKg;
    return acc;
  }, {} as Record<string, number>);
  console.log('Product Tonnage:', Object.fromEntries(Object.entries(productTonnage).map(([k, v]) => [k, v / 1000 + ' MT'])));
} 
main().catch(console.error).finally(() => prisma.$disconnect());
