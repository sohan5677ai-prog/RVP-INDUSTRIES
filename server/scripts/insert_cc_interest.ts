import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { signToken } from '../src/lib/jwt.js';

const prisma = new PrismaClient();

const payments = [
  { date: '2026-04-30T00:00:00Z', amount: 390946, type: 'CC', note: 'April CC Interest' },
  { date: '2026-05-31T00:00:00Z', amount: 463609, type: 'CC', note: 'May CC Interest' },
  { date: '2026-06-30T00:00:00Z', amount: 486961, type: 'CC', note: 'June CC Interest' }
];

async function main() {
  const token = signToken({ userId: 'admin', role: 'ADMIN' });
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  // 1. Delete the wrong payments
  const badPaymentIds = ['cmrix6uxp0003s8409xml8s76', 'cmrix6v1u000bs840ha9u0fc6', 'cmrix6v3z000js840vhnhzjrf'];
  for (const id of badPaymentIds) {
    const res = await fetch(`http://localhost:4000/api/payments/${id}`, { method: 'DELETE', headers });
    if (!res.ok) {
      console.log(`Could not delete payment ${id} (maybe already deleted)`, await res.text());
    } else {
      console.log(`Deleted incorrect payment ${id}`);
    }
  }

  // 2. Insert the correct InterestCharges
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
