import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient, GroupNature, StatementType, AccountType } from '@prisma/client';

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Tally-style account-group tree. Primaries first (parent: null), then the
// sub-groups that reference a parent by name. nature fixes the Dr/Cr sign;
// statement decides Balance Sheet vs Profit & Loss placement.
// ---------------------------------------------------------------------------
type GroupDef = {
  name: string;
  parent?: string;
  nature: GroupNature;
  statement: StatementType;
  sortOrder: number;
};

const GROUPS: GroupDef[] = [
  // ── Balance Sheet - Liabilities side ──
  { name: 'Capital Account', nature: 'LIABILITIES', statement: 'BALANCE_SHEET', sortOrder: 10 },
  { name: 'Reserves & Surplus', parent: 'Capital Account', nature: 'LIABILITIES', statement: 'BALANCE_SHEET', sortOrder: 11 },
  { name: 'Loans (Liability)', nature: 'LIABILITIES', statement: 'BALANCE_SHEET', sortOrder: 20 },
  { name: 'Bank OD A/c', parent: 'Loans (Liability)', nature: 'LIABILITIES', statement: 'BALANCE_SHEET', sortOrder: 21 },
  { name: 'Secured Loans', parent: 'Loans (Liability)', nature: 'LIABILITIES', statement: 'BALANCE_SHEET', sortOrder: 22 },
  { name: 'Unsecured Loans', parent: 'Loans (Liability)', nature: 'LIABILITIES', statement: 'BALANCE_SHEET', sortOrder: 23 },
  { name: 'Current Liabilities', nature: 'LIABILITIES', statement: 'BALANCE_SHEET', sortOrder: 30 },
  { name: 'Duties & Taxes', parent: 'Current Liabilities', nature: 'LIABILITIES', statement: 'BALANCE_SHEET', sortOrder: 31 },
  { name: 'Provisions', parent: 'Current Liabilities', nature: 'LIABILITIES', statement: 'BALANCE_SHEET', sortOrder: 32 },
  { name: 'Sundry Creditors', parent: 'Current Liabilities', nature: 'LIABILITIES', statement: 'BALANCE_SHEET', sortOrder: 33 },
  { name: 'Profit & Loss A/c', nature: 'LIABILITIES', statement: 'BALANCE_SHEET', sortOrder: 40 },

  // ── Balance Sheet - Assets side ──
  { name: 'Fixed Assets', nature: 'ASSETS', statement: 'BALANCE_SHEET', sortOrder: 50 },
  { name: 'Investments', nature: 'ASSETS', statement: 'BALANCE_SHEET', sortOrder: 60 },
  { name: 'Current Assets', nature: 'ASSETS', statement: 'BALANCE_SHEET', sortOrder: 70 },
  { name: 'Stock-in-Hand', parent: 'Current Assets', nature: 'ASSETS', statement: 'BALANCE_SHEET', sortOrder: 71 },
  { name: 'Sundry Debtors', parent: 'Current Assets', nature: 'ASSETS', statement: 'BALANCE_SHEET', sortOrder: 72 },
  { name: 'Cash-in-Hand', parent: 'Current Assets', nature: 'ASSETS', statement: 'BALANCE_SHEET', sortOrder: 73 },
  { name: 'Bank Accounts', parent: 'Current Assets', nature: 'ASSETS', statement: 'BALANCE_SHEET', sortOrder: 74 },
  { name: 'Loans & Advances (Asset)', parent: 'Current Assets', nature: 'ASSETS', statement: 'BALANCE_SHEET', sortOrder: 75 },
  { name: 'Deposits (Asset)', parent: 'Current Assets', nature: 'ASSETS', statement: 'BALANCE_SHEET', sortOrder: 76 },

  // ── Profit & Loss ──
  { name: 'Sales Accounts', nature: 'INCOME', statement: 'PROFIT_LOSS', sortOrder: 80 },
  { name: 'Purchase Accounts', nature: 'EXPENSES', statement: 'PROFIT_LOSS', sortOrder: 81 },
  { name: 'Direct Incomes', nature: 'INCOME', statement: 'PROFIT_LOSS', sortOrder: 82 },
  { name: 'Direct Expenses', nature: 'EXPENSES', statement: 'PROFIT_LOSS', sortOrder: 83 },
  { name: 'Indirect Incomes', nature: 'INCOME', statement: 'PROFIT_LOSS', sortOrder: 84 },
  { name: 'Indirect Expenses', nature: 'EXPENSES', statement: 'PROFIT_LOSS', sortOrder: 85 },
];

// ---------------------------------------------------------------------------
// Ledgers (accounts). openingBalance is SIGNED: +Dr (assets/expenses) / -Cr
// (liabilities/income/capital). Opening figures are brought forward from the
// owner's Tally balance sheet so the report ties out; live ERP postings add on
// top. The opening trial balance nets to exactly zero (Σ opening = 0).
// ---------------------------------------------------------------------------
type LedgerDef = {
  code: string;
  name: string;
  type: AccountType;
  group: string;
  opening?: number;
  sortOrder?: number;
};

const LEDGERS: LedgerDef[] = [
  // ── Capital Account (₹2,15,13,342.00) ──
  { code: '30010', name: 'K Chandrakalavaty Capital Account', type: 'EQUITY', group: 'Capital Account', opening: -16061966.00, sortOrder: 1 },
  { code: '30020', name: 'M Padmavathy Capital Account', type: 'EQUITY', group: 'Capital Account', opening: -5451376.00, sortOrder: 2 },

  // ── Loans (Liability) (₹9,47,82,833.94) ──
  { code: '21010', name: 'Bank OD A/c', type: 'LIABILITY', group: 'Bank OD A/c', opening: -59978632.24, sortOrder: 1 },
  { code: '21020', name: 'Secured Term Loans', type: 'LIABILITY', group: 'Secured Loans', opening: -36597209.70, sortOrder: 1 },
  { code: '20290', name: 'Bank Loan Payable (Principal)', type: 'LIABILITY', group: 'Secured Loans', sortOrder: 2 },
  { code: '21030', name: 'Jansamarth Loan - 145', type: 'LIABILITY', group: 'Unsecured Loans', opening: -1000000.00, sortOrder: 1 },
  { code: '21031', name: 'Kesava Reddy', type: 'LIABILITY', group: 'Unsecured Loans', sortOrder: 2 },
  { code: '21032', name: 'Manikumar', type: 'LIABILITY', group: 'Unsecured Loans', sortOrder: 3 },
  { code: '21039', name: 'Unsecured Loans - Adjustments', type: 'LIABILITY', group: 'Unsecured Loans', opening: 2793008.00, sortOrder: 4 },

  // ── Current Liabilities (₹59,29,534.90) ──
  { code: '22010', name: 'Duties & Taxes (Opening)', type: 'LIABILITY', group: 'Duties & Taxes', opening: -1145158.63, sortOrder: 1 },
  { code: '20220', name: 'IGST Payable (Output)', type: 'LIABILITY', group: 'Duties & Taxes', sortOrder: 2 },
  { code: '22020', name: 'Provisions (Opening)', type: 'LIABILITY', group: 'Provisions', opening: -3000.00, sortOrder: 1 },
  { code: '20200', name: 'Outstanding Labor Liability - Hamali', type: 'LIABILITY', group: 'Provisions', sortOrder: 2 },
  { code: '20280', name: 'Bank Loan Interest Payable', type: 'LIABILITY', group: 'Provisions', sortOrder: 3 },
  { code: '22030', name: 'Sundry Creditors (Opening)', type: 'LIABILITY', group: 'Sundry Creditors', opening: -4781376.27, sortOrder: 1 },
  { code: '20100', name: 'Accounts Payable - Suppliers', type: 'LIABILITY', group: 'Sundry Creditors', sortOrder: 2 },
  { code: '20210', name: 'Transport Payable - Transfers', type: 'LIABILITY', group: 'Sundry Creditors', sortOrder: 3 },
  { code: '20230', name: 'Freight Payable - Transporters', type: 'LIABILITY', group: 'Sundry Creditors', sortOrder: 4 },
  { code: '20240', name: 'Brokerage Payable', type: 'LIABILITY', group: 'Sundry Creditors', sortOrder: 5 },
  { code: '20250', name: 'Lorry Owner Payable - Freight', type: 'LIABILITY', group: 'Sundry Creditors', sortOrder: 6 },
  { code: '20255', name: 'Surya Roadlines Payable', type: 'LIABILITY', group: 'Sundry Creditors', sortOrder: 7 },
  { code: '20270', name: 'Kata Fee Payable', type: 'LIABILITY', group: 'Sundry Creditors', sortOrder: 8 },

  // ── Profit & Loss A/c - accumulated retained earnings brought forward
  //    (₹12,74,19,493.20). Current-period live profit is added on top by the report. ──
  { code: '31000', name: 'Profit & Loss A/c (Brought Forward)', type: 'EQUITY', group: 'Profit & Loss A/c', opening: -127419493.20, sortOrder: 1 },

  // ── Fixed Assets (₹5,68,63,326.75) ──
  { code: '13010', name: 'Fixed Assets', type: 'ASSET', group: 'Fixed Assets', opening: 56863326.75, sortOrder: 1 },

  // ── Investments (structural, nil opening) ──
  { code: '11010', name: 'Nagaraja B - Account', type: 'ASSET', group: 'Investments', sortOrder: 1 },
  { code: '11011', name: 'Neha Agency - Account', type: 'ASSET', group: 'Investments', sortOrder: 2 },
  { code: '11012', name: 'Vijayalakshmi - Account', type: 'ASSET', group: 'Investments', sortOrder: 3 },

  // ── Current Assets (₹19,27,81,877.29) ──
  { code: '10010', name: 'Closing Stock', type: 'ASSET', group: 'Stock-in-Hand', opening: 153294903.11, sortOrder: 1 },
  { code: '10060', name: 'Tamarind Shell Inventory', type: 'ASSET', group: 'Stock-in-Hand', sortOrder: 2 },
  { code: '10100', name: 'Accounts Receivable - Buyers', type: 'ASSET', group: 'Sundry Debtors', opening: 29313629.76, sortOrder: 1 },
  { code: '10410', name: 'Cash-in-Hand', type: 'ASSET', group: 'Cash-in-Hand', opening: 158081.50, sortOrder: 1 },
  { code: '10400', name: 'Bank / Cash Account', type: 'ASSET', group: 'Bank Accounts', opening: 1428108.97, sortOrder: 1 },
  { code: '12011', name: 'Seeni - UBI Account', type: 'ASSET', group: 'Bank Accounts', sortOrder: 2 },
  { code: '12020', name: 'Loans & Advances (Opening)', type: 'ASSET', group: 'Loans & Advances (Asset)', opening: 6568791.00, sortOrder: 1 },
  { code: '10200', name: 'Transit Loss Claim Receivable', type: 'ASSET', group: 'Loans & Advances (Asset)', sortOrder: 2 },
  { code: '10300', name: 'Hamali Recoverable - Lorry', type: 'ASSET', group: 'Loans & Advances (Asset)', sortOrder: 3 },
  { code: '12030', name: 'APSPDCL - AP Transco', type: 'ASSET', group: 'Deposits (Asset)', opening: 1844868.95, sortOrder: 1 },
  { code: '12040', name: 'Input Tax Credit', type: 'ASSET', group: 'Current Assets', opening: 305256.00, sortOrder: 1 },
  { code: '12041', name: 'Interest Receivable', type: 'ASSET', group: 'Current Assets', opening: -180000.00, sortOrder: 2 },
  { code: '10500', name: 'TDS Receivable', type: 'ASSET', group: 'Current Assets', opening: 48238.00, sortOrder: 3 },

  // ── Profit & Loss statement ledgers (nil opening; reset each period) ──
  { code: '40010', name: 'Sales Revenue', type: 'REVENUE', group: 'Sales Accounts', sortOrder: 1 },
  { code: '40020', name: 'Purchase Discount', type: 'REVENUE', group: 'Indirect Incomes', sortOrder: 1 },
  { code: '40030', name: 'Hamali Income', type: 'REVENUE', group: 'Indirect Incomes', sortOrder: 2 },
  { code: '50010', name: 'Cost of Goods Sold', type: 'EXPENSE', group: 'Direct Expenses', sortOrder: 1 },
  { code: '50020', name: 'Factory Labor Expense', type: 'EXPENSE', group: 'Direct Expenses', sortOrder: 2 },
  { code: '50030', name: 'Factory Overhead Expense', type: 'EXPENSE', group: 'Direct Expenses', sortOrder: 3 },
  { code: '50040', name: 'Yield Variance Expense / Loss', type: 'EXPENSE', group: 'Direct Expenses', sortOrder: 4 },
  { code: '50090', name: 'Transport Expense (Internal)', type: 'EXPENSE', group: 'Direct Expenses', sortOrder: 5 },
  { code: '50120', name: 'Pre Cleaner Dust Purchases', type: 'EXPENSE', group: 'Direct Expenses', sortOrder: 6 },
  { code: '50050', name: 'Freight Outward (Selling Expense)', type: 'EXPENSE', group: 'Indirect Expenses', sortOrder: 1 },
  { code: '50070', name: 'Loading Hamali Expense (Selling)', type: 'EXPENSE', group: 'Indirect Expenses', sortOrder: 2 },
  { code: '50080', name: 'Interest Expense', type: 'EXPENSE', group: 'Indirect Expenses', sortOrder: 3 },
  { code: '50100', name: 'Sales Shortage & Allowances', type: 'EXPENSE', group: 'Indirect Expenses', sortOrder: 4 },

  // ── Direct-cash expense heads (populated from the Payments screen) ──
  { code: '50250', name: 'Hamali Expense (Paid)', type: 'EXPENSE', group: 'Direct Expenses', sortOrder: 20 },
  { code: '50240', name: 'Packing Material - Gunny Bags', type: 'EXPENSE', group: 'Direct Expenses', sortOrder: 21 },
  { code: '50210', name: 'Diesel & Fuel', type: 'EXPENSE', group: 'Indirect Expenses', sortOrder: 20 },
  { code: '50260', name: 'Transport Fee', type: 'EXPENSE', group: 'Indirect Expenses', sortOrder: 21 },
  { code: '50220', name: 'Electricity Charges', type: 'EXPENSE', group: 'Indirect Expenses', sortOrder: 22 },
  { code: '50230', name: 'Repairs & Maintenance', type: 'EXPENSE', group: 'Indirect Expenses', sortOrder: 23 },

  // ── Direct-cash income heads (populated from the Receipts screen) ──
  { code: '40110', name: 'Gunny Bag Sales', type: 'REVENUE', group: 'Indirect Incomes', sortOrder: 20 },
  { code: '40120', name: 'Scrap & Waste Sales', type: 'REVENUE', group: 'Indirect Incomes', sortOrder: 21 },
  { code: '40130', name: 'Interest Income', type: 'REVENUE', group: 'Indirect Incomes', sortOrder: 22 },

  // ── Proprietor drawings (contra-capital; debited when owners withdraw cash) ──
  { code: '30030', name: 'Proprietor Drawings', type: 'EQUITY', group: 'Capital Account', sortOrder: 3 },
];

// Decommissioned heads → where their historical journal lines are re-pointed so
// nothing is orphaned and the trial balance still nets to zero. The accounts are
// then flagged isDeprecated (zero lines, hidden from the live chart).
const DEPRECATED_REPOINT: Record<string, string> = {
  '10020': '10010', // WIP Inventory → Closing Stock
  '10030': '10010', // White Pappu Inventory → Closing Stock
  '10040': '10010', // Husk Inventory → Closing Stock
  '10050': '10010', // Waste Inventory → Closing Stock
  '20260': '20255', // Freight Retention Held → Surya Roadlines Payable
  '40040': '10010', // Internal Weight Profit (no posted lines) → Closing Stock
  '50060': '10010', // Brokerage Expense → Closing Stock (negligible dev-data amounts)
};

async function seedChartOfAccounts() {
  // 1. Groups - primaries first so sub-groups can resolve their parent id.
  const groupId = new Map<string, string>();
  for (const g of GROUPS.filter((x) => !x.parent)) {
    const rec = await prisma.accountGroup.upsert({
      where: { name: g.name },
      update: { nature: g.nature, statement: g.statement, sortOrder: g.sortOrder, parentId: null },
      create: { name: g.name, nature: g.nature, statement: g.statement, sortOrder: g.sortOrder },
    });
    groupId.set(g.name, rec.id);
  }
  for (const g of GROUPS.filter((x) => x.parent)) {
    const parentId = groupId.get(g.parent!);
    const rec = await prisma.accountGroup.upsert({
      where: { name: g.name },
      update: { nature: g.nature, statement: g.statement, sortOrder: g.sortOrder, parentId },
      create: { name: g.name, nature: g.nature, statement: g.statement, sortOrder: g.sortOrder, parentId },
    });
    groupId.set(g.name, rec.id);
  }

  // 2. Ledgers - upsert with group, opening balance, and reactivate (not deprecated).
  for (const l of LEDGERS) {
    const gid = groupId.get(l.group);
    if (!gid) throw new Error(`Seed error: group "${l.group}" not found for ledger ${l.code}`);
    await prisma.account.upsert({
      where: { code: l.code },
      update: {
        name: l.name,
        type: l.type,
        groupId: gid,
        openingBalance: l.opening ?? 0,
        sortOrder: l.sortOrder ?? 0,
        isDeprecated: false,
      },
      create: {
        code: l.code,
        name: l.name,
        type: l.type,
        groupId: gid,
        openingBalance: l.opening ?? 0,
        sortOrder: l.sortOrder ?? 0,
      },
    });
  }

  // 3. Decommission removed heads - re-point any historical lines, then flag.
  for (const [fromCode, toCode] of Object.entries(DEPRECATED_REPOINT)) {
    const from = await prisma.account.findUnique({ where: { code: fromCode } });
    if (!from) continue;
    const to = await prisma.account.findUnique({ where: { code: toCode } });
    if (to) {
      await prisma.journalLine.updateMany({
        where: { accountId: from.id },
        data: { accountId: to.id },
      });
    }
    await prisma.account.update({
      where: { code: fromCode },
      data: { isDeprecated: true, openingBalance: 0, groupId: null },
    });
  }
}

async function main() {
  // --- Admin user ---
  const adminUsername = 'admin';
  const passwordHash = await bcrypt.hash('admin123', 10);

  await prisma.user.upsert({
    where: { username: adminUsername },
    update: {},
    create: {
      name: 'RVP Admin',
      username: adminUsername,
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

  // --- Tally-style Chart of Accounts (groups + ledgers + opening balances) ---
  await seedChartOfAccounts();

  // --- Default freight destinations (rates editable in Settings) ---
  for (const destination of ['Surat', 'Barshi', 'Nagar']) {
    const existing = await prisma.freightRate.findUnique({ where: { destination } });
    if (!existing) {
      await prisma.freightRate.create({ data: { destination, ratePerTonne: 0 } });
    }
  }

  console.log('Seed complete.');
  console.log('  Admin login → admin / admin123');
  console.log('  Chart of accounts: Tally groups + opening balances loaded.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
