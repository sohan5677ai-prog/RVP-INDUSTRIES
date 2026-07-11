import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
prisma.hamaliRate.findMany({ where: { isCustom: true } }).then(console.log).finally(() => prisma.$disconnect());
