import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
prisma.purchase.findFirst({where: {hamaliCharge: 0}, include: {verification: true}}).then(p => {
    console.log('Verification exists:', !!p?.verification);
}).catch(console.error);
