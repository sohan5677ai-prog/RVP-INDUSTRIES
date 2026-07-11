const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    const p = await prisma.purchase.findMany({ select: { id: true, kataFee: true } });
    const s = await prisma.saleDispatch.findMany({ select: { id: true, freightKata: true, weightKg: true, vehicleNumber: true } });
    
    console.log('Purchases with 0 kata:', p.filter(x => Number(x.kataFee) === 0).length);
    console.log('Sales with 0 kata:', s.filter(x => x.freightKata === 0).length);
    const zeroSales = s.filter(x => x.freightKata === 0);
    console.log('Sample sales with 0 kata:', zeroSales.slice(0, 5));
}
main().finally(() => prisma.$disconnect());
