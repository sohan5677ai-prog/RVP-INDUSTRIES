import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { signToken } from '../src/lib/jwt.js';

const prisma = new PrismaClient();

const payments = [
  { date: '2026-04-30T00:00:00Z', amount: 249863, type: 'TERM_LOAN', note: 'April Term Loan Interest' },
  { date: '2026-05-31T00:00:00Z', amount: 237820, type: 'TERM_LOAN', note: 'May Term Loan Interest' },
  { date: '2026-06-30T00:00:00Z', amount: 235445, type: 'TERM_LOAN', note: 'June Term Loan Interest' }
];

async function main() {
  const token = signToken({ userId: 'admin', role: 'ADMIN' });
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  for (const p of payments) {
    const res = await fetch('http://localhost:4000/api/interest-charges', {
      method: 'POST',
      headers,
      body: JSON.stringify(p)
    });

    if (!res.ok) {
      console.error(`Failed to create interest charge for ${p.note}`, await res.text());
    } else {
      const created = await res.json();
      console.log(`Created Interest Charge: ${p.note} (ID: ${created.id})`);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
