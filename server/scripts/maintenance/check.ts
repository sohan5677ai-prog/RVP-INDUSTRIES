import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
prisma.purchase.findMany({ select: { id: true, kataFee: true, netWeightKg: true, stockIn: { select: { lorryNumber: true } } } }).then(p => {
    const zero = p.filter(x => Number(x.kataFee) === 0);
    console.log('Zero kata purchases:', zero.slice(0, 50));
}).finally(() => prisma.$disconnect());
