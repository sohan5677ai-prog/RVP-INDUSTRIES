import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { LedgerService } from '../src/services/ledger.service.js';

const prisma = new PrismaClient();

const payments = [
  { date: '2026-04-30T00:00:00Z', amount: 555769, note: 'April' },
  { date: '2026-05-31T00:00:00Z', amount: 562180, note: 'May' },
  { date: '2026-06-30T00:00:00Z', amount: 555555, note: 'June' },
];

async function main() {
  for (const p of payments) {
    await prisma.$transaction(async (tx) => {
      const row = await tx.termLoanPrincipal.create({
        data: { date: p.date, amount: p.amount, note: p.note },
      });
      await LedgerService.recordLinkedPayment(tx, {
        date: new Date(p.date),
        amount: Number(p.amount),
        type: 'TERM_LOAN_PRINCIPAL',
        payee: 'Term Loan Principal',
        description: p.note,
        refKey: `PRINCIPAL-${row.id}`,
      });
      console.log(`Inserted principal for ${p.note}: ₹${p.amount}`);
    });
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
