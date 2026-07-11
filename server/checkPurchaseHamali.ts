import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
prisma.purchase.findFirst({where: {hamaliCharge: 0}}).then(console.log).catch(console.error);
