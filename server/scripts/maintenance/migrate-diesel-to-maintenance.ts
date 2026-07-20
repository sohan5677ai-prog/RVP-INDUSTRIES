// One-time migration: Diesel is being moved out of the Hamali Ledger (where it
// was mis-booked as a crew labor charge — Dr Factory Labor 50020 / Cr Hamali
// payable 20200) and into the Expenses → Maintenance tab as a real paid expense.
//
// For every `manualHamaliCost` of type DIESEL this script:
//   1. creates a MaintenanceExpense row (so it shows on the Maintenance tab), and
//      posts its linked Payment (Dr Repairs & Maintenance 50230 / Cr Bank 10400)
//      exactly like a UI-entered maintenance expense;
//   2. reverses the old hamali GL posting (deletes the MANUAL-HAMALI-<id> journal
//      entry) so the P&L / husk pool don't double-count the cost; and
//   3. deletes the old manualHamaliCost row.
//
// NOTE ON HAMALI PAYABLE: removing the old Cr to 20200 reduces the Hamali payable
// by the diesel total — correct, since diesel was never actually owed to the crew.
// Re-verify the Hamali Ledger crew-outstanding tile after running.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { LedgerService } from '../../src/services/ledger.service.js';

const prisma = new PrismaClient();

async function main() {
  const dieselRows = await prisma.manualHamaliCost.findMany({
    where: { type: 'DIESEL' as any },
    orderBy: { date: 'asc' },
  });

  console.log(`Found ${dieselRows.length} DIESEL hamali charge(s) to migrate.`);

  let migrated = 0;
  let total = 0;
  for (const row of dieselRows) {
    const amount = Number(row.amount);
    await prisma.$transaction(async (tx) => {
      const created = await tx.maintenanceExpense.create({
        data: {
          date: row.date,
          description: 'Diesel',
          amount: row.amount,
          note: row.note ?? null,
        },
      });

      await LedgerService.recordLinkedPayment(tx, {
        date: row.date,
        amount,
        type: 'MAINTENANCE',
        payee: 'Diesel',
        description: row.note ?? undefined,
        refKey: `MAINTENANCE-${created.id}`,
      });

      // Reverse the original hamali accrual (Dr 50020 / Cr 20200).
      await tx.journalEntry.deleteMany({ where: { reference: `MANUAL-HAMALI-${row.id}` } });
      await tx.manualHamaliCost.delete({ where: { id: row.id } });
    });

    console.log(`  Migrated ${row.date.toISOString().slice(0, 10)}  ₹${amount.toLocaleString('en-IN')}${row.note ? `  (${row.note})` : ''}`);
    migrated++;
    total += amount;
  }

  console.log(`\nDone. Migrated ${migrated} diesel entr${migrated === 1 ? 'y' : 'ies'} into Maintenance (₹${total.toLocaleString('en-IN')} total).`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
