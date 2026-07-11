import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
prisma.purchase.findMany().then(p => {
    const zero = p.filter(x => Number(x.hamaliCharge) === 0);
    console.log('Zero hamali purchases:', zero.length);
}).catch(console.error);
