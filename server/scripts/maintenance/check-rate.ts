import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
prisma.hamaliRate.findUnique({ where: { key: 'PAPPU_LOADING' } }).then(console.log).finally(() => prisma.$disconnect());
