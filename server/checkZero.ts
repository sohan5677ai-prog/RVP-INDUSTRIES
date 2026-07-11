import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
prisma.purchase.count({where: {hamaliCharge: 0}}).then(c => console.log('Remaining zero hamali:', c)).catch(console.error);
