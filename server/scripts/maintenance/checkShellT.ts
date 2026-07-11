import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
prisma.shellTransfer.findMany().then(ts => {
    console.log('Total Shell Transfers:', ts.length);
}).catch(console.error);
