import { prisma } from '../lib/prisma.js';
import { Prisma } from '@prisma/client';
import { hamaliSplit } from '../lib/calc.js';

export interface JournalLineInput {
  accountCode: string;
  debit: number;
  credit: number;
  costCenter?: string;
}

/**
 * Direct-cash expense (and drawings) payment categories. Each debits its own
 * ledger head — so the Profit & Loss report shows a separate line per category —
 * and credits Bank/Cash. Unlike SUPPLIER/TRANSPORTER/BROKER (which settle an
 * existing payable), these book the expense at the moment cash goes out.
 * The account is upserted on first use, so no reseed is required.
 */
export const EXPENSE_PAYMENT_ACCOUNTS: Record<
  string,
  { code: string; name: string; group: string; type: 'EXPENSE' | 'EQUITY'; sortOrder: number }
> = {
  GUNNY_BAGS: { code: '50240', name: 'Packing Material - Gunny Bags', group: 'Direct Expenses', type: 'EXPENSE', sortOrder: 21 },
  TRANSPORT: { code: '50260', name: 'Transport Fee', group: 'Indirect Expenses', type: 'EXPENSE', sortOrder: 21 },
  ELECTRICITY: { code: '50220', name: 'Electricity Charges', group: 'Indirect Expenses', type: 'EXPENSE', sortOrder: 22 },
  STORAGE_ELECTRICITY: { code: '50222', name: 'Storage Electricity Charges', group: 'Indirect Expenses', type: 'EXPENSE', sortOrder: 27 },
  STORAGE_SALARY: { code: '50210', name: 'Storage Staff Salaries', group: 'Indirect Expenses', type: 'EXPENSE', sortOrder: 28 },
  MAINTENANCE: { code: '50230', name: 'Repairs & Maintenance', group: 'Indirect Expenses', type: 'EXPENSE', sortOrder: 23 },
  MISC_EXPENSE: { code: '50270', name: 'Miscellaneous Expenses', group: 'Indirect Expenses', type: 'EXPENSE', sortOrder: 29 },
  CC_INTEREST: { code: '50250', name: 'Bank Interest - CC', group: 'Indirect Expenses', type: 'EXPENSE', sortOrder: 24 },
  TERM_LOAN_INTEREST: { code: '50255', name: 'Interest - Term Loan', group: 'Indirect Expenses', type: 'EXPENSE', sortOrder: 25 },
  TERM_LOAN_PRINCIPAL: { code: '50256', name: 'Principal - Term Loan', group: 'Indirect Expenses', type: 'EXPENSE', sortOrder: 26 },
  DRAWINGS: { code: '30030', name: 'Proprietor Drawings', group: 'Capital Account', type: 'EQUITY', sortOrder: 30 },
};

/** All payment `type` values accepted by the ERP (counterparty settlements + direct expenses). */
export const PAYMENT_TYPES = [
  'SUPPLIER',
  'TRANSPORTER',
  'BROKER',
  // Crew-settlement payment: debits the Hamali payable (20200) instead of a P&L
  // expense head (the expense was booked at accrual). Routed in postPayment below.
  'HAMALI',
  ...Object.keys(EXPENSE_PAYMENT_ACCOUNTS),
  'OTHER',
] as [string, ...string[]];

/**
 * Direct-cash income receipt categories. Each credits its own revenue head — so
 * the Profit & Loss report shows a separate line per income stream — and debits
 * Bank/Cash. Unlike BUYER (which settles an outstanding receivable), these book
 * the income at the moment cash comes in. Accounts upsert on first use.
 */
export const INCOME_RECEIPT_ACCOUNTS: Record<
  string,
  { code: string; name: string; group: string; type: 'REVENUE'; sortOrder: number }
> = {
  GUNNY_BAGS_SALE: { code: '40110', name: 'Gunny Bag Sales', group: 'Indirect Incomes', type: 'REVENUE', sortOrder: 20 },
  SCRAP_SALE: { code: '40120', name: 'Scrap & Waste Sales', group: 'Indirect Incomes', type: 'REVENUE', sortOrder: 21 },
  HAMALI_INCOME: { code: '40030', name: 'Hamali Income', group: 'Indirect Incomes', type: 'REVENUE', sortOrder: 2 },
  INTEREST_INCOME: { code: '40130', name: 'Interest Income', group: 'Indirect Incomes', type: 'REVENUE', sortOrder: 22 },
};

/** All receipt `type` values accepted by the ERP (receivable collection + direct incomes). */
export const RECEIPT_TYPES = [
  'BUYER',
  ...Object.keys(INCOME_RECEIPT_ACCOUNTS),
  'OTHER',
] as [string, ...string[]];

export class LedgerService {
  /**
   * Post a double-entry journal entry inside a transaction.
   * Validates that total debits equal total credits.
   */
  static async postJournalEntry(
    tx: Prisma.TransactionClient,
    data: {
      date: Date;
      reference: string;
      description: string;
      lines: JournalLineInput[];
    }
  ) {
    const totalDebits = data.lines.reduce((sum, line) => sum + line.debit, 0);
    const totalCredits = data.lines.reduce((sum, line) => sum + line.credit, 0);

    // Validate double-entry balance (allowing 0.02 tolerance for rounding issues)
    if (Math.abs(totalDebits - totalCredits) > 0.02) {
      throw new Error(
        `Journal entry does not balance. Debits: ₹${totalDebits.toFixed(2)}, Credits: ₹${totalCredits.toFixed(
          2
        )}`
      );
    }

    // Adjust minor difference (due to floating point) to the first debit line
    let adjustedLines = [...data.lines];
    const diff = totalDebits - totalCredits;
    if (Math.abs(diff) > 0 && Math.abs(diff) <= 0.02) {
      const idx = adjustedLines.findIndex((l) => l.debit > 0);
      if (idx !== -1) {
        adjustedLines[idx].debit = Number((adjustedLines[idx].debit - diff).toFixed(2));
      }
    }

    // Ensure new standard accounts exist if referenced
    const requiredCodes = adjustedLines.map((l) => l.accountCode);
    const knownAccounts = {
      '10400': { name: 'Bank / Cash Account', type: 'ASSET' as const },
      '20240': { name: 'Brokerage Payable', type: 'LIABILITY' as const },
      '50070': { name: 'Loading Hamali Expense (Selling)', type: 'EXPENSE' as const },
      '20280': { name: 'Bank Loan Interest Payable', type: 'LIABILITY' as const },
      '20290': { name: 'Bank Loan Payable (Principal)', type: 'LIABILITY' as const },
      '10500': { name: 'TDS Receivable', type: 'ASSET' as const },
      '50100': { name: 'Sales Shortage & Allowances', type: 'EXPENSE' as const }
    };
    for (const code of requiredCodes) {
      if (code in knownAccounts) {
        const val = knownAccounts[code as keyof typeof knownAccounts];
        await tx.account.upsert({
          where: { code },
          update: {},
          create: { code, name: val.name, type: val.type }
        });
      }
    }

    // Resolve account IDs
    const accounts = await tx.account.findMany({
      where: { code: { in: adjustedLines.map((l) => l.accountCode) } },
    });

    const accountMap = new Map(accounts.map((a) => [a.code, a.id]));

    // Create journal entry
    const entry = await tx.journalEntry.create({
      data: {
        date: data.date,
        reference: data.reference,
        description: data.description,
      },
    });

    // Create lines
    await tx.journalLine.createMany({
      data: adjustedLines.map((line) => {
        const accountId = accountMap.get(line.accountCode);
        if (!accountId) {
          throw new Error(`Chart of Account not found for code: ${line.accountCode}`);
        }
        return {
          journalEntryId: entry.id,
          accountId,
          debit: line.debit,
          credit: line.credit,
          costCenter: line.costCenter || null,
        };
      }),
    });

    return entry;
  }

  /**
   * Post ledger when purchase is verified.
   * Debits Raw Material Inventory, Credits AP Suppliers.
   * Accounts for Hamali (unloading) accrual.
   */
  static async postPurchaseVerification(tx: Prisma.TransactionClient, purchaseId: string) {
    const p = await tx.purchase.findUnique({
      where: { id: purchaseId },
      include: {
        verification: true,
        stockIn: { include: { purchaseOrder: { include: { party: true } } } },
      },
    });
    if (!p || !p.verification) return;

    const company = await tx.companyProfile.findFirst();
    const isCompanyVehicle = p.stockIn.lorryNumber ? (company?.companyVehicles ?? '').toLowerCase().includes(p.stockIn.lorryNumber.toLowerCase().trim()) : false;
    // We could use isVehicleExempt from calc.ts, but we're in ledger.service.ts
    // Let's implement simple check here to avoid circular imports if any, or just import it.
    // Wait, let's just do a simple robust check:
    const knmList = (company?.companyVehicles || '').split(/[\n,]+/).map(v => v.trim().toLowerCase()).filter(v => v);
    const isKnm = p.stockIn.lorryNumber ? knmList.includes(p.stockIn.lorryNumber.trim().toLowerCase()) : false;

    // totalAmount is the party's NET payable (already net of any self-vehicle
    // hamali AND kata). The seed keeps the hamali (add it back) but not the kata
    // (it lowered the landed cost), so baseCost = seed value net of the kata.
    const selfHam = Number(p.verification.selfVehicleHamali);
    const netPayable = Number(p.verification.totalAmount);
    const baseCost = netPayable + selfHam; // includes IGST; split out below
    const discountVal = Number(p.discountValue);
    // Input IGST paid to the supplier is claimable Input Tax Credit - NOT a cost of
    // the stock. It is carved out of the inventory debit and parked in 12040, so the
    // seed (Closing Stock) is valued EXCLUSIVE of GST. GST still sits in the supplier
    // payable (we owe the supplier the gross, GST included).
    const igst = p.stockIn.purchaseOrder.hasGst
      ? Math.round(Number(p.verification.billingWeightKg) * Number(p.verification.pricePerKg) * 0.05 * 100) / 100
      : 0;
    const stockDebit = baseCost - igst; // seed landed value, EXCLUDING GST
    // Arrival hamali profit-centre split: the seed bears its share, the lorry
    // funds the rest, the crew is paid, and the company keeps the margin.
    const h = hamaliSplit(Number(p.hamaliCharge), isKnm);
    const freight = Number(p.freightCharge);
    const supplierName = p.stockIn.purchaseOrder.party.name;
    const location = p.stockIn.loadingLocation;

    const lines: JournalLineInput[] = [];

    // 1. Inventory & Supplier payables
    // Debit Closing Stock at the GST-EXCLUSIVE landed value.
    lines.push({
      accountCode: '10010', // Closing Stock (Raw Material Inventory)
      debit: stockDebit + discountVal,
      credit: 0,
      costCenter: location,
    });

    // Debit the recoverable Input Tax Credit for the GST portion (not stock cost).
    if (igst > 0) {
      lines.push({
        accountCode: '12040', // Input Tax Credit
        debit: igst,
        credit: 0,
      });
    }

    // Credit Supplier Payable (net amount, GST included - reduced by any self-vehicle
    // hamali recovered from the party in lieu of the lorry's share).
    lines.push({
      accountCode: '20100', // Accounts Payable - Suppliers
      debit: 0,
      credit: netPayable,
    });

    // Credit Discount if any
    if (discountVal > 0) {
      lines.push({
        accountCode: '40020', // Purchase Discount
        debit: 0,
        credit: discountVal,
      });
    }

    // 2. Hamali accrual (₹150/t profit-centre). Funding: seed bears `inventory`,
    // lorry funds `lorry`. Usage: crew is paid `crew`, company keeps `margin`.
    if (h.total > 0) {
      lines.push({
        accountCode: '10010', // Raw Material Inventory - seed's capitalised share
        debit: h.inventory,
        credit: 0,
        costCenter: location,
      });
      // The lorry's share is recoverable from the transporter - UNLESS the party
      // came in their own vehicle, in which case it was already netted off their
      // supplier payable above (no separate receivable).
      if (selfHam <= 0 && h.lorry > 0) {
        lines.push({
          accountCode: '10300', // Hamali Recoverable - Lorry
          debit: h.lorry,
          credit: 0,
        });
      }
      lines.push({
        accountCode: '20200', // Outstanding Labor Liability - Hamali (crew payable)
        debit: 0,
        credit: h.crew,
        costCenter: 'Hamali Team',
      });
      if (h.margin > 0) {
        lines.push({
          accountCode: '40030', // Hamali Income (company margin)
          debit: 0,
          credit: h.margin,
        });
      }
    }

    // 4. Inward freight (BASE-priced POs) - capitalised into the seed.
    if (freight > 0) {
      lines.push({
        accountCode: '10010', // Raw Material Inventory
        debit: freight,
        credit: 0,
        costCenter: location,
      });
      lines.push({
        accountCode: isKnm ? '20260' : '20230', // KNM Transport Payable vs Freight Payable - Transporters
        debit: 0,
        credit: freight,
      });
    }

    await this.postJournalEntry(tx, {
      date: p.verification.createdAt,
      reference: `PURCHASE-${p.id}`,
      description: `Purchase verification for stock arrival from ${supplierName} (Lorry ${p.stockIn.lorryNumber})`,
      lines,
    });
  }

  /**
   * Post a storage→process stock transfer. The seed's value moves between silos
   * (Raw Material Inventory, different cost centres), and the transfer costs -
   * two hamali legs and transport - are capitalised onto the seed
   * at the destination. Hamali legs recognise the company's margin as income.
   */
  static async postStockTransfer(
    tx: Prisma.TransactionClient,
    transferId: string,
    data: {
      fromLocation: string;
      toLocation: string;
      weightKg: number;
      seedCostMoved: number;
      legCharge: number; // loading + unloading charge (capitalised)
      legCrew: number; // crew paid across both legs
      legMargin: number; // company hamali margin across both legs
      transportCharge: number;
      interestCharge?: number; // bank-loan carrying interest, capitalised into the seed
    }
  ) {
    const lines: JournalLineInput[] = [];

    // 1. Move the seed's existing value between silos.
    if (data.seedCostMoved > 0) {
      lines.push({ accountCode: '10010', debit: data.seedCostMoved, credit: 0, costCenter: data.toLocation });
      lines.push({ accountCode: '10010', debit: 0, credit: data.seedCostMoved, costCenter: data.fromLocation });
    }

    // 2. Hamali legs (loading + unloading) - capitalised into the seed at the
    // destination (they travel with the seed to RVP), owed to the crew.
    if (data.legCharge > 0) {
      lines.push({ accountCode: '10010', debit: data.legCharge, credit: 0, costCenter: data.toLocation }); // Raw Material Inventory
      lines.push({ accountCode: '20200', debit: 0, credit: data.legCrew, costCenter: 'Hamali Team' });
      if (data.legMargin > 0) {
        lines.push({ accountCode: '40030', debit: 0, credit: data.legMargin });
      }
    }

    // 3. Transfer transport - capitalised into the seed at the destination,
    // owed to KNM Transport.
    if (data.transportCharge > 0) {
      lines.push({ accountCode: '10010', debit: data.transportCharge, credit: 0, costCenter: data.toLocation }); // Raw Material Inventory
      lines.push({ accountCode: '20260', debit: 0, credit: data.transportCharge }); // KNM Transport Payable
    }

    // 5. Bank-loan carrying interest - CAPITALISED into the seed at the destination
    // (Dr Raw Material Inventory), accrued as a payable to the bank. It reaches the
    // P&L exactly once - via COGS when the seed is sold - NOT as a separate interest
    // expense here (that would double-count). The 20280 accrual is later settled by
    // the interest portion of a loan repayment (Dr 20280 / Cr Bank).
    if (data.interestCharge && data.interestCharge > 0) {
      lines.push({ accountCode: '10010', debit: data.interestCharge, credit: 0, costCenter: data.toLocation }); // Raw Material Inventory
      lines.push({ accountCode: '20280', debit: 0, credit: data.interestCharge }); // Bank Loan Interest Payable (accrued)
    }

    if (lines.length === 0) return;

    await this.postJournalEntry(tx, {
      date: new Date(),
      reference: `TRANSFER-${transferId}`,
      description: `Transferred ${data.weightKg} kg black seed from ${data.fromLocation} to ${data.toLocation}`,
      lines,
    });
  }

  /**
   * Post a tamarind shell transfer to another location. Shell is no longer held as
   * a valued silo - the transfer is purely a physical movement, so its cost
   * (hamali crew + transport) is EXPENSED (not capitalised): the crew is owed via
   * the hamali payable and the transport via the KNM Transport payable.
   */
  static async postShellTransfer(
    tx: Prisma.TransactionClient,
    transferId: string,
    data: {
      toLocation: string;
      weightKg: number;
      hamaliCharge: number;
      transportCharge: number;
    }
  ) {
    const lines: JournalLineInput[] = [];

    if (data.hamaliCharge > 0) {
      lines.push({ accountCode: '50070', debit: data.hamaliCharge, credit: 0, costCenter: data.toLocation }); // Loading Hamali Expense
      lines.push({ accountCode: '20200', debit: 0, credit: data.hamaliCharge, costCenter: 'Hamali Team' });
    }

    if (data.transportCharge > 0) {
      lines.push({ accountCode: '50090', debit: data.transportCharge, credit: 0, costCenter: data.toLocation }); // Transport Expense (Internal)
      lines.push({ accountCode: '20260', debit: 0, credit: data.transportCharge }); // KNM Transport Payable
    }

    if (lines.length === 0) return;

    await this.postJournalEntry(tx, {
      date: new Date(),
      reference: `SHELL-TRANSFER-${transferId}`,
      description: `Transferred ${data.weightKg} kg tamarind shell to ${data.toLocation}`,
      lines,
    });
  }

  /**
   * Post a husk transfer from the factory to a storage location. Like the shell
   * transfer, the ₹333/t hamali and per-tonne transport are expensed against the
   * hamali team / KNM Transport payables. Physical-movement + cost record only.
   */
  static async postHuskTransfer(
    tx: Prisma.TransactionClient,
    transferId: string,
    data: {
      toLocation: string;
      weightKg: number;
      hamaliCharge: number;
      transportCharge: number;
    }
  ) {
    const lines: JournalLineInput[] = [];

    if (data.hamaliCharge > 0) {
      lines.push({ accountCode: '50070', debit: data.hamaliCharge, credit: 0, costCenter: data.toLocation }); // Loading Hamali Expense
      lines.push({ accountCode: '20200', debit: 0, credit: data.hamaliCharge, costCenter: 'Hamali Team' });
    }

    if (data.transportCharge > 0) {
      lines.push({ accountCode: '50090', debit: data.transportCharge, credit: 0, costCenter: data.toLocation }); // Transport Expense (Internal)
      lines.push({ accountCode: '20260', debit: 0, credit: data.transportCharge }); // KNM Transport Payable
    }

    if (lines.length === 0) return;

    await this.postJournalEntry(tx, {
      date: new Date(),
      reference: `HUSK-TRANSFER-${transferId}`,
      description: `Transferred ${data.weightKg} kg husk to ${data.toLocation}`,
      lines,
    });
  }

  /**
   * Post a pre-cleaner dust purchase bought IN from an outside party. The dust is
   * bought to resell, so its cost is a direct expense (Dr Pre Cleaner Dust
   * Purchases) and the supplier is owed the amount (Cr Accounts Payable).
   */
  static async postDustPurchase(
    tx: Prisma.TransactionClient,
    purchaseId: string,
    data: { date: Date; amount: number; weightKg: number; partyName: string }
  ) {
    if (data.amount <= 0) return;
    await this.postJournalEntry(tx, {
      date: data.date,
      reference: `DUST-PURCHASE-${purchaseId}`,
      description: `Purchased ${data.weightKg} kg pre-cleaner dust from ${data.partyName}`,
      lines: [
        { accountCode: '50120', debit: data.amount, credit: 0 }, // Pre Cleaner Dust Purchases
        { accountCode: '20100', debit: 0, credit: data.amount }, // Accounts Payable - Suppliers
      ],
    });
  }

  /**
   * Post a bank-loan drawdown: cash comes in, principal owed to the bank.
   * Dr Bank/Cash / Cr Bank Loan Payable (Principal).
   */
  static async postLoanDrawdown(
    tx: Prisma.TransactionClient,
    loanId: string,
    data: { date: Date; amount: number; bankName?: string | null; loanRef?: string | null }
  ) {
    if (data.amount <= 0) return;
    await this.postJournalEntry(tx, {
      date: data.date,
      reference: `LOAN-DRAW-${loanId}`,
      description: `Bank loan drawdown of ₹${data.amount.toFixed(2)}${data.bankName ? ` from ${data.bankName}` : ''}${data.loanRef ? ` (${data.loanRef})` : ''}`,
      lines: [
        { accountCode: '10400', debit: data.amount, credit: 0 }, // Bank / Cash
        { accountCode: '20290', debit: 0, credit: data.amount }, // Bank Loan Payable (Principal)
      ],
    });
  }

  /**
   * Post a bank-loan repayment out of cash: a principal portion that reduces the
   * loan payable (Dr 20290) and an optional interest portion that settles the
   * capitalised-interest accrual (Dr 20280 - NOT interest expense, since the
   * interest already reached the P&L via COGS on the seed it was capitalised into).
   * Both are funded by Bank/Cash (Cr 10400).
   */
  static async postLoanRepayment(
    tx: Prisma.TransactionClient,
    repaymentId: string,
    data: { date: Date; amount: number; interest?: number; reference?: string | null }
  ) {
    const interest = data.interest && data.interest > 0 ? data.interest : 0;
    const cashOut = data.amount + interest;
    if (cashOut <= 0) return;

    const lines: JournalLineInput[] = [];
    if (data.amount > 0) {
      lines.push({ accountCode: '20290', debit: data.amount, credit: 0 }); // Bank Loan Payable (Principal)
    }
    if (interest > 0) {
      lines.push({ accountCode: '20280', debit: interest, credit: 0 }); // Bank Loan Interest Payable (accrual settled)
    }
    lines.push({ accountCode: '10400', debit: 0, credit: cashOut }); // Bank / Cash

    const desc =
      `Bank loan repayment of ₹${data.amount.toFixed(2)}` +
      (interest > 0 ? ` + interest ₹${interest.toFixed(2)}` : '') +
      (data.reference ? ` (${data.reference})` : '');

    await this.postJournalEntry(tx, {
      date: data.date,
      reference: `LOAN-REPAY-${repaymentId}`,
      description: desc,
      lines,
    });
  }

  // Milling no longer posts to the financial ledger. WIP / White Pappu / Husk /
  // Waste inventory heads were decommissioned in the Tally chart; the seed's
  // value stays in the single Raw Material / Closing Stock pool (10010) and the
  // physical conversion is tracked operationally (Processing / Silo inventory).
  // COGS still relieves 10010 on sale, so the books stay balanced.

  /**
   * Post a sale on dispatch: A/R for the gross (base + GST), revenue for the base,
   * IGST output liability for the tax. For Pappu, also book COGS against the
   * black-seed pool. Byproducts (Husk/Waste/TPS) carry no COGS.
   */
  static async postSale(
    tx: Prisma.TransactionClient,
    saleOrderId: string,
    data: {
      buyerName: string;
      product: string;
      baseAmount: number;
      gstAmount: number;
      cogsAmount: number;
      freightAmount: number;
      weightKg: number;
      // COGS inventory credit account/cost-centre. Defaults to the black-seed
      // pool (pappu); shell sales relieve the shell inventory instead.
      cogsInventoryAccount?: string;
      cogsCostCenter?: string;
      // Production cost (₹/kg components) added to COGS, absorbed from overhead.
      productionCostAmount?: number;
      // Lorry-freight split: from the total freight we hold a retention (paid to
      // Surya Roadlines at delivery) and deduct loading hamali + kata; the
      // remainder is the lorry owner's payable.
      //   freightUnloadingHamali = hamali amount deducted off the lorry's freight
      //   hamaliCrewPayable      = total hamali paid to the crew (20200)
      //   hamaliCompanyExpense   = our (company-borne) loading-hamali cost (50070)
      //   hamaliMargin           = company hamali profit → P/L (40030)
      freightUnloadingHamali?: number;
      freightKata?: number;
      freightRetention?: number;
      hamaliCrewPayable?: number;
      hamaliCompanyExpense?: number;
      hamaliMargin?: number;
      isCompanyVehicle?: boolean;
    }
  ) {
    const lines: JournalLineInput[] = [
      {
        accountCode: '10100', // Accounts Receivable - Buyers
        debit: Math.round((data.baseAmount + data.gstAmount) * 100) / 100,
        credit: 0,
      },
      {
        accountCode: '40010', // Sales Revenue (tagged by product)
        debit: 0,
        credit: data.baseAmount,
        costCenter: data.product,
      },
    ];

    if (data.gstAmount > 0) {
      lines.push({
        accountCode: '20220', // IGST Payable (Output)
        debit: 0,
        credit: data.gstAmount,
      });
    }

    if (data.cogsAmount > 0) {
      lines.push({
        accountCode: '50010', // Cost of Goods Sold
        debit: data.cogsAmount,
        credit: 0,
      });
      lines.push({
        accountCode: data.cogsInventoryAccount ?? '10010', // inventory relieved (black-seed pool by default)
        debit: 0,
        credit: data.cogsAmount,
        costCenter: data.cogsCostCenter ?? 'Black Seed Pool',
      });
    }

    // Production cost (electricity/labour/etc.) added to COGS, absorbed from the
    // factory-overhead pool.
    const productionCost = data.productionCostAmount ?? 0;
    if (productionCost > 0) {
      lines.push({
        accountCode: '50010', // Cost of Goods Sold
        debit: productionCost,
        credit: 0,
        costCenter: data.product,
      });
      lines.push({
        accountCode: '50030', // Factory Overhead Expense (absorption credit)
        debit: 0,
        credit: productionCost,
        costCenter: 'Mill Line 1',
      });
    }

    // Outward delivery lorry freight we bear, split at dispatch:
    //   Dr Freight Outward (full)  /  Cr Lorry Owner Payable (remainder)
    //   Cr Freight Retention Held (released to Surya Roadlines at delivery)
    //   Cr Hamali payable (destination unloading) + Cr Kata Fee Payable
    if (data.freightAmount > 0) {
      const uh = data.freightUnloadingHamali ?? 0; // hamali deducted off the freight (lorry share)
      const kata = data.freightKata ?? 0;
      const retention = data.freightRetention ?? 0;
      const isKnm = data.isCompanyVehicle ?? false;
      const crewHamali = data.hamaliCrewPayable ?? uh; // paid to the crew (defaults to the deducted amount)
      const companyHamali = data.hamaliCompanyExpense ?? 0; // our share (company-borne loading cost)
      const marginHamali = data.hamaliMargin ?? 0; // company hamali profit → P/L
      const lorryOwner = Math.round((data.freightAmount - uh - kata - retention) * 100) / 100;

      lines.push({
        accountCode: '50050', // Freight Outward (Selling Expense)
        debit: data.freightAmount,
        credit: 0,
        costCenter: data.product,
      });
      lines.push({
        accountCode: isKnm ? '20260' : '20250', // KNM Transport Payable vs Lorry Owner Payable
        debit: 0,
        credit: lorryOwner,
      });
      if (companyHamali > 0) {
        lines.push({
          accountCode: '50070', // Loading Hamali Expense (Selling) - our share
          debit: companyHamali,
          credit: 0,
          costCenter: data.product,
        });
      }
      if (retention > 0) {
        lines.push({
          accountCode: '20255', // Surya Roadlines Payable (retained freight, owed directly)
          debit: 0,
          credit: retention,
        });
      }
      if (crewHamali > 0) {
        lines.push({
          accountCode: '20200', // Outstanding Labor Liability - Hamali (loading crew)
          debit: 0,
          credit: crewHamali,
          costCenter: 'Hamali Team',
        });
      }
      if (marginHamali > 0) {
        lines.push({
          accountCode: '40030', // Hamali Income (company margin on loading hamali)
          debit: 0,
          credit: marginHamali,
          costCenter: data.product,
        });
      }
      if (kata > 0) {
        lines.push({
          accountCode: '20270', // Kata Fee Payable
          debit: 0,
          credit: kata,
        });
      }
    } else if ((data.hamaliCompanyExpense ?? 0) > 0) {
      // Company-borne loading hamali with no lorry freight to split against
      // (e.g. husk lifted ex-works). Still post full hamali split so P/L is correct,
      // and lorry share hits recoverable to be collected in cash later.
      const companyHamali = data.hamaliCompanyExpense ?? 0;
      const crewHamali = data.hamaliCrewPayable ?? companyHamali;
      const lorryHamali = data.freightUnloadingHamali ?? 0;
      const marginHamali = data.hamaliMargin ?? 0;
      const kata = data.freightKata ?? 0;

      lines.push({
        accountCode: '50070', // Loading Hamali Expense (Selling) - our share
        debit: companyHamali,
        credit: 0,
        costCenter: data.product,
      });
      if (lorryHamali > 0 || kata > 0) {
        lines.push({
          accountCode: '10300', // Hamali/Kata Recoverable - Lorry
          debit: lorryHamali + kata,
          credit: 0,
        });
      }
      lines.push({
        accountCode: '20200', // Outstanding Labor Liability - Hamali (loading crew)
        debit: 0,
        credit: crewHamali,
        costCenter: 'Hamali Team',
      });
      if (kata > 0) {
        lines.push({
          accountCode: '20270', // Kata Fee Payable
          debit: 0,
          credit: kata,
        });
      }
      if (marginHamali > 0) {
        lines.push({
          accountCode: '40030', // Hamali Income
          debit: 0,
          credit: marginHamali,
          costCenter: data.product,
        });
      }
    }

    // Brokerage is no longer accrued to the financial ledger - it is tracked
    // operationally (Brokerage Ledger / Dues) from sale orders and broker payments.

    await this.postJournalEntry(tx, {
      date: new Date(),
      reference: `SALE-${saleOrderId}`,
      description: `Sale dispatch of ${data.weightKg} kg ${data.product} to buyer ${data.buyerName}`,
      lines,
    });
  }

  // The "Freight Retention Held" head was decommissioned. The retained freight
  // is now credited directly to Surya Roadlines Payable (20255) at dispatch in
  // postSale, so there is no separate held balance to release on delivery.

  static async postSaleCreditNote(
    tx: Prisma.TransactionClient,
    saleOrderId: string,
    data: {
      buyerName: string;
      product: string;
      shortageKg: number;
      baseAmount: number;
      gstAmount: number;
    }
  ) {
    const lines: JournalLineInput[] = [
      {
        accountCode: '40010', // Sales Revenue
        debit: data.baseAmount,
        credit: 0,
        costCenter: data.product,
      },
      {
        accountCode: '10100', // Accounts Receivable - Buyers
        debit: 0,
        credit: Math.round((data.baseAmount + data.gstAmount) * 100) / 100,
      },
    ];

    if (data.gstAmount > 0) {
      lines.push({
        accountCode: '20220', // IGST Payable (Output)
        debit: data.gstAmount,
        credit: 0,
      });
    }

    // We do not reverse COGS or Inventory because the physical stock was indeed dispatched and lost (shortage).
    // The loss is borne by us through reduced revenue.

    await this.postJournalEntry(tx, {
      date: new Date(),
      reference: `CN-${saleOrderId}`,
      description: `Credit Note for delivery shortage of ${data.shortageKg} kg on sale to ${data.buyerName}`,
      lines,
    });
  }

  // Internal Weight Profit (40040) was decommissioned from the chart of accounts.
  // The moisture-gain figure is still computed and saved on the dispatch record
  // and shown in the operational Internal Weight Ledger report, but is no longer
  // posted to the financial ledger.

  static async postPayment(
    tx: Prisma.TransactionClient,
    paymentId: string,
    data: {
      date: Date;
      amount: number;
      type: string;
      partyName?: string;
      brokerName?: string;
      lorryNumber?: string;
      payee?: string;
      reference?: string;
      description?: string;
    }
  ) {
    let debitAccount = '50030'; // Default: Factory Overhead Expense for OTHER
    let partyRef = data.payee || '';

    // Check if the lorry is a KNM vehicle (to route payments against 20260)
    let isKnm = false;
    if (data.lorryNumber) {
      const company = await tx.companyProfile.findFirst();
      const knmList = (company?.companyVehicles || '').split(/[\n,]+/).map(v => v.trim().toLowerCase()).filter(v => v);
      isKnm = knmList.includes(data.lorryNumber.trim().toLowerCase());
    }

    if (data.type === 'SUPPLIER') {
      debitAccount = '20100'; // Accounts Payable - Suppliers
      partyRef = data.partyName || '';
    } else if (data.type === 'TRANSPORTER_INWARD') {
      debitAccount = isKnm ? '20260' : '20230'; // Freight Payable - Transporters
      partyRef = data.lorryNumber ? `Lorry ${data.lorryNumber}` : '';
    } else if (data.type === 'TRANSPORTER_OUTWARD') {
      debitAccount = isKnm ? '20260' : '20250'; // Lorry Owner Payable - Freight
      partyRef = data.lorryNumber ? `Lorry ${data.lorryNumber}` : '';
    } else if (data.type === 'BROKER') {
      debitAccount = '20240'; // Brokerage Payable
      partyRef = data.brokerName || '';
    } else if (data.type === 'HAMALI') {
      // Settle the accrued crew liability rather than booking a fresh expense.
      debitAccount = '20200'; // Outstanding Labor Liability - Hamali (crew payable)
      partyRef = data.partyName || 'Hamali Team';
    } else if (EXPENSE_PAYMENT_ACCOUNTS[data.type]) {
      // Direct-cash expense / drawings: book straight to its own P&L (or capital) head.
      const acct = EXPENSE_PAYMENT_ACCOUNTS[data.type];
      const grp = await tx.accountGroup.findUnique({ where: { name: acct.group } });
      await tx.account.upsert({
        where: { code: acct.code },
        update: {},
        create: {
          code: acct.code,
          name: acct.name,
          type: acct.type,
          groupId: grp?.id ?? null,
          sortOrder: acct.sortOrder,
        },
      });
      debitAccount = acct.code;
      partyRef = data.payee || acct.name;
    }

    const lines: JournalLineInput[] = [
      {
        accountCode: debitAccount,
        debit: data.amount,
        credit: 0,
        costCenter:
          data.type === 'TRANSPORTER'
            ? data.lorryNumber
            : data.type === 'HAMALI'
              ? 'Hamali Team'
              : undefined,
      },
      {
        accountCode: '10400', // Bank / Cash Account
        debit: 0,
        credit: data.amount,
      },
    ];

    await this.postJournalEntry(tx, {
      date: data.date,
      reference: `PAYMENT-${paymentId}`,
      description: `Payment to ${data.type} ${partyRef}. Ref: ${data.reference || '-'}. ${data.description || ''}`.trim(),
      lines,
    });
  }

  static async postReceipt(
    tx: Prisma.TransactionClient,
    receiptId: string,
    data: {
      date: Date;
      amount: number;
      type: string;
      partyName?: string;
      payer?: string;
      reference?: string;
      description?: string;
    }
  ) {
    let creditAccount = '40010'; // Default: Sales Revenue for OTHER
    let partyRef = data.payer || '';
    if (data.type === 'BUYER') {
      creditAccount = '10100'; // Accounts Receivable - Buyers
      partyRef = data.partyName || '';
    } else if (INCOME_RECEIPT_ACCOUNTS[data.type]) {
      // Direct-cash income: book straight to its own P&L revenue head.
      const acct = INCOME_RECEIPT_ACCOUNTS[data.type];
      const grp = await tx.accountGroup.findUnique({ where: { name: acct.group } });
      await tx.account.upsert({
        where: { code: acct.code },
        update: {},
        create: {
          code: acct.code,
          name: acct.name,
          type: acct.type,
          groupId: grp?.id ?? null,
          sortOrder: acct.sortOrder,
        },
      });
      creditAccount = acct.code;
      partyRef = data.payer || acct.name;
    }

    const lines: JournalLineInput[] = [
      {
        accountCode: '10400', // Bank / Cash Account
        debit: data.amount,
        credit: 0,
      },
      {
        accountCode: creditAccount,
        debit: 0,
        credit: data.amount,
      },
    ];

    return this.postJournalEntry(tx, {
      date: data.date,
      reference: `RECEIPT-${receiptId}`,
      description: `Receipt from ${partyRef || 'Other'}${data.reference ? ` (Ref: ${data.reference})` : ''}`,
      lines,
    });
  }

  /**
   * Create a Payment row + its ledger posting for an entry that originates on a
   * detail page (Gunny Bags, Electricity, Maintenance, Drawings). The journal
   * `reference` is a caller-supplied key (e.g. `GUNNYBAG-<id>`) so the owning
   * page can reverse it on delete — deleting that journal entry cascades the
   * Payment away, so no extra link column is needed. The Payment then shows up
   * on the Payments page and in the main P&L automatically.
   */
  static async recordLinkedPayment(
    tx: Prisma.TransactionClient,
    data: {
      date: Date;
      amount: number;
      type: string;      // an EXPENSE_PAYMENT_ACCOUNTS key, e.g. 'GUNNY_BAGS'
      payee?: string;
      description?: string;
      refKey: string;    // deterministic journal reference, e.g. `GUNNYBAG-<id>`
    }
  ) {
    const payment = await tx.payment.create({
      data: {
        date: data.date,
        amount: data.amount,
        type: data.type,
        payee: data.payee ?? null,
        description: data.description ?? null,
      },
    });

    let debitAccount = '50030'; // Factory Overhead fallback
    const acct = EXPENSE_PAYMENT_ACCOUNTS[data.type];
    if (acct) {
      const grp = await tx.accountGroup.findUnique({ where: { name: acct.group } });
      await tx.account.upsert({
        where: { code: acct.code },
        update: {},
        create: { code: acct.code, name: acct.name, type: acct.type, groupId: grp?.id ?? null, sortOrder: acct.sortOrder },
      });
      debitAccount = acct.code;
    }

    const je = await this.postJournalEntry(tx, {
      date: data.date,
      reference: data.refKey,
      description: `${acct?.name ?? 'Expense'} ${data.payee ? `- ${data.payee} ` : ''}${data.description ? `(${data.description})` : ''}`.trim(),
      lines: [
        { accountCode: debitAccount, debit: data.amount, credit: 0 },
        { accountCode: '10400', debit: 0, credit: data.amount },
      ],
    });

    await tx.payment.update({ where: { id: payment.id }, data: { journalEntryId: je.id } });
    return payment;
  }

  /**
   * Income twin of {@link recordLinkedPayment}: create a Receipt row + its ledger
   * posting for a detail-page income entry (e.g. a Gunny Bag SALE). Reversed by
   * deleting the journal entry identified by `refKey`.
   */
  static async recordLinkedReceipt(
    tx: Prisma.TransactionClient,
    data: {
      date: Date;
      amount: number;
      type: string;      // an INCOME_RECEIPT_ACCOUNTS key, e.g. 'GUNNY_BAGS_SALE'
      payer?: string;
      description?: string;
      refKey: string;
    }
  ) {
    const receipt = await tx.receipt.create({
      data: {
        date: data.date,
        amount: data.amount,
        type: data.type,
        payer: data.payer ?? null,
        description: data.description ?? null,
      },
    });

    let creditAccount = '40010'; // Sales Revenue fallback
    const acct = INCOME_RECEIPT_ACCOUNTS[data.type];
    if (acct) {
      const grp = await tx.accountGroup.findUnique({ where: { name: acct.group } });
      await tx.account.upsert({
        where: { code: acct.code },
        update: {},
        create: { code: acct.code, name: acct.name, type: acct.type, groupId: grp?.id ?? null, sortOrder: acct.sortOrder },
      });
      creditAccount = acct.code;
    }

    const je = await this.postJournalEntry(tx, {
      date: data.date,
      reference: data.refKey,
      description: `${acct?.name ?? 'Income'} ${data.payer ? `- ${data.payer} ` : ''}${data.description ? `(${data.description})` : ''}`.trim(),
      lines: [
        { accountCode: '10400', debit: data.amount, credit: 0 },
        { accountCode: creditAccount, debit: 0, credit: data.amount },
      ],
    });

    await tx.receipt.update({ where: { id: receipt.id }, data: { journalEntryId: je.id } });
    return receipt;
  }

  static async postSaleTdsDeduction(
    tx: Prisma.TransactionClient,
    dispatchId: string,
    data: {
      date: Date;
      buyerName: string;
      tdsAmount: number;
    }
  ) {
    if (data.tdsAmount <= 0) return;
    const lines: JournalLineInput[] = [];

    // Debit TDS Receivable (Asset)
    lines.push({
      accountCode: '10500', // TDS Receivable
      debit: data.tdsAmount,
      credit: 0,
    });

    // Credit Accounts Receivable - Buyers
    lines.push({
      accountCode: '10100', // Accounts Receivable - Buyers
      debit: 0,
      credit: data.tdsAmount,
    });

    return this.postJournalEntry(tx, {
      date: data.date,
      reference: `TDS-${dispatchId}`,
      description: `TDS Deducted by ${data.buyerName}`,
      lines,
    });
  }

  static async postSaleShortageDeduction(
    tx: Prisma.TransactionClient,
    dispatchId: string,
    data: {
      date: Date;
      buyerName: string;
      shortageAmount: number;
    }
  ) {
    if (data.shortageAmount <= 0) return;
    const lines: JournalLineInput[] = [];

    // Debit Sales Shortage & Allowances (Expense)
    lines.push({
      accountCode: '50100',
      debit: data.shortageAmount,
      credit: 0,
    });

    // Credit Accounts Receivable - Buyers
    lines.push({
      accountCode: '10100', // Accounts Receivable - Buyers
      debit: 0,
      credit: data.shortageAmount,
    });

    return this.postJournalEntry(tx, {
      date: data.date,
      reference: `SHORTAGE-${dispatchId}`,
      description: `Shortage / Allowance claimed by ${data.buyerName}`,
      lines,
    });
  }
}
