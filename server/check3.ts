import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
prisma.saleDispatch.findMany({ select: { id: true, freightKata: true, weightKg: true, vehicleNumber: true } }).then(s => {
    // Note: freightKata is not in DB! We saw that error before.
    console.log('Checked');
}).finally(() => prisma.$disconnect());
