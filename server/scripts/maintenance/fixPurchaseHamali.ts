import { PrismaClient } from '@prisma/client';
import { calcHamali } from './src/lib/calc.js';
import { LedgerService } from './src/services/ledger.service.js';
const prisma = new PrismaClient();

async function main() {
    const purchases = await prisma.purchase.findMany({ 
        where: { hamaliCharge: 0 },
        include: { verification: true }
    });
    
    console.log(`Found ${purchases.length} purchases with 0 hamali charge.`);
    
    let fixed = 0;
    for (const p of purchases) {
        if (!p.verification) {
            console.log(`Purchase ${p.id} has no verification, skipping.`);
            continue;
        }

        const correctCharge = calcHamali(p.netWeightKg, Number(p.hamaliRate || 80));
        if (correctCharge === 0) continue;
        
        await prisma.$transaction(async tx => {
            // Update purchase
            await tx.purchase.update({
                where: { id: p.id },
                data: { hamaliCharge: correctCharge }
            });

            // Find existing journal entry
            const ref = `PURCHASE-${p.id}`;
            const entry = await tx.journalEntry.findFirst({
                where: { reference: ref }
            });

            if (entry) {
                // Delete old journal lines and entry
                await tx.journalLine.deleteMany({ where: { journalEntryId: entry.id } });
                await tx.journalEntry.delete({ where: { id: entry.id } });
            }

            // Post new journal entry
            await LedgerService.postPurchaseVerification(tx, p.id);

            // Re-date the newly created journal entry
            if (entry) {
                await tx.journalEntry.updateMany({
                    where: { reference: ref },
                    data: { date: entry.date, createdAt: entry.createdAt }
                });
            }
        });
        fixed++;
    }
    
    console.log(`Fixed ${fixed} purchases.`);
}
main().finally(() => prisma.$disconnect());
