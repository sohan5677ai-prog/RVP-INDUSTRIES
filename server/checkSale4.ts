import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
prisma.saleDispatch.findMany({ where: { saleOrder: { product: 'PAPPU' } } }).then(async ds => {
    let missing = 0;
    for(const d of ds) {
        const e = await prisma.journalEntry.findFirst({
            where: { OR: [{reference: 'SALE-'+d.id}, {reference: 'SALE-'+d.saleOrderId}] }
        });
        if (!e) missing++;
    }
    console.log('Missing ledger entries:', missing);
}).catch(console.error);
