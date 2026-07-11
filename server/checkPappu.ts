import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
prisma.saleDispatch.findMany({ include: { saleOrder: { include: { buyer: true } } } }).then(d => {
    const pappu = d.filter(x => x.saleOrder.product === 'PAPPU');
    console.log('Pappu sales count:', pappu.length);
    console.log('Zero freight count:', pappu.filter(x => Number(x.freightCharge) === 0).length);
    console.log('Unique destinations:', [...new Set(pappu.map(x => x.saleOrder.buyer.destination))]);
    
    // Also log the freight rates table
    return prisma.freightRate.findMany();
}).then(rates => {
    console.log('Freight rates in DB:', rates);
}).finally(() => prisma.$disconnect());
