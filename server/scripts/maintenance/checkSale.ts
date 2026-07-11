import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
prisma.journalEntry.findFirst({ where: { reference: { startsWith: 'SALE-' } }, include: { lines: true } }).then(e => console.dir(e, {depth:null})).finally(() => prisma.$disconnect());
