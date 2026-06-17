import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // --- Admin user ---
  const adminEmail = 'admin@rvp.local';
  const passwordHash = await bcrypt.hash('admin123', 10);

  await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      name: 'RVP Admin',
      email: adminEmail,
      password: passwordHash,
      role: 'ADMIN',
    },
  });

  // --- Sample parties ---
  const parties = [
    { name: 'Sri Venkateswara Traders', type: 'SUPPLIER' as const, phone: '9876543210', address: 'Anantapur, AP' },
    { name: 'Lakshmi Tamarind Agro', type: 'SUPPLIER' as const, phone: '9876501234', address: 'Hindupur, AP' },
    { name: 'Krishna Exports', type: 'BUYER' as const, phone: '9123456780', address: 'Chennai, TN' },
  ];

  for (const p of parties) {
    const existing = await prisma.party.findFirst({ where: { name: p.name } });
    if (!existing) {
      await prisma.party.create({ data: p });
    }
  }

  // --- Sample broker ---
  const brokerName = 'Ramesh Commission Agent';
  const existingBroker = await prisma.broker.findFirst({ where: { name: brokerName } });
  if (!existingBroker) {
    await prisma.broker.create({ data: { name: brokerName, phone: '9001122334' } });
  }

  // --- Default Chart of Accounts ---
  const defaultAccounts = [
    { code: '10010', name: 'Raw Material Inventory', type: 'ASSET' as const },
    { code: '10020', name: 'Work-in-Progress (WIP) Inventory', type: 'ASSET' as const },
    { code: '10030', name: 'White Pappu Inventory', type: 'ASSET' as const },
    { code: '10040', name: 'Husk Inventory', type: 'ASSET' as const },
    { code: '10050', name: 'Waste Inventory', type: 'ASSET' as const },
    { code: '10100', name: 'Accounts Receivable - Buyers', type: 'ASSET' as const },
    { code: '10200', name: 'Transit Loss Claim Receivable', type: 'ASSET' as const },
    { code: '20100', name: 'Accounts Payable - Suppliers', type: 'LIABILITY' as const },
    { code: '20200', name: 'Outstanding Labor Liability - Hamali', type: 'LIABILITY' as const },
    { code: '40010', name: 'Sales Revenue', type: 'REVENUE' as const },
    { code: '40020', name: 'Purchase Discount', type: 'REVENUE' as const },
    { code: '50010', name: 'Cost of Goods Sold', type: 'EXPENSE' as const },
    { code: '50020', name: 'Factory Labor Expense', type: 'EXPENSE' as const },
    { code: '50030', name: 'Factory Overhead Expense', type: 'EXPENSE' as const },
    { code: '50040', name: 'Yield Variance Expense / Loss', type: 'EXPENSE' as const },
  ];

  for (const ac of defaultAccounts) {
    const existing = await prisma.account.findUnique({ where: { code: ac.code } });
    if (!existing) {
      await prisma.account.create({ data: ac });
    }
  }

  console.log('Seed complete.');
  console.log('  Admin login → admin@rvp.local / admin123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
