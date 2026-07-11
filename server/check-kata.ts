import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
prisma.account.findMany().then(r => console.log(r.filter(a => a.name.toLowerCase().includes('kata')).map(a => a.name))).finally(() => prisma.$disconnect());
