import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
prisma.journalEntry.findMany({ where: { reference: { startsWith: 'SALE-' } } }).then(entries => {
    console.log('Total SALE entries:', entries.length);
    console.log(entries.map(e => e.reference).slice(0, 5));
}).catch(console.error);
