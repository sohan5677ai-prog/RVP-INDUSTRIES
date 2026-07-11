import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
prisma.companyProfile.findFirst().then(c => {
    console.log('Company vehicles:', c.companyVehicles);
}).finally(() => prisma.$disconnect());
