import { PrismaClient } from '@prisma/client';
import { calcKataFee } from './src/lib/calc.js';
const prisma = new PrismaClient();

async function main() {
    const purchases = await prisma.purchase.findMany({ 
        where: { kataFee: 0 },
        select: { id: true, netWeightKg: true }
    });
    
    console.log(`Found ${purchases.length} purchases with 0 kata fee.`);
    
    for (const p of purchases) {
        const correctFee = calcKataFee(p.netWeightKg, false);
        await prisma.purchase.update({
            where: { id: p.id },
            data: { kataFee: correctFee }
        });
    }
    
    console.log('Fixed all purchases.');
}
main().finally(() => prisma.$disconnect());
