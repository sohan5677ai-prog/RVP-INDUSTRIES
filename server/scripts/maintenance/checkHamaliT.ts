import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
prisma.stockTransfer.findMany().then(ts => {
    const zero = ts.filter(t => Number(t.loadingHamali) === 0 && Number(t.unloadingHamali) === 0);
    console.log('Zero hamali transfers:', zero.length, 'out of', ts.length);
}).catch(console.error);
