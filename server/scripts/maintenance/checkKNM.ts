import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
prisma.account.findMany({where: {name: {contains: 'KNM', mode: 'insensitive'}}}).then(console.log).catch(console.error);
