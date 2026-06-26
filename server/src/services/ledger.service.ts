import { prisma } from '../lib/prisma.js';
import { Prisma } from '@prisma/client';
import { hamaliSplit } from '../lib/calc.js';

export interface JournalLineInput {
  accountCode: string;
  debit: number;
  credit: number;
  costCenter?: string;
}

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
      '50060': { name: 'Brokerage Expense', type: 'EXPENSE' as const },
      '50070': { name: 'Loading Hamali Expense (Selling)', type: 'EXPENSE' as const },
      '20280': { name: 'Bank Loan Interest Payable', type: 'LIABILITY' as const },
      '20290': { name: 'Bank Loan Payable (Principal)', type: 'LIABILITY' as const }
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

    const baseCost = Number(p.verification.totalAmount);
    const discountVal = Number(p.discountValue);
    // Arrival hamali profit-centre split: the seed bears its share, the lorry
    // funds the rest, the crew is paid, and the company keeps the margin.
    const h = hamaliSplit(Number(p.hamaliCharge));
    const bagCut = Number(p.bagCuttingCharge);
    const freight = Number(p.freightCharge);
    const supplierName = p.stockIn.purchaseOrder.party.name;
    const location = p.stockIn.loadingLocation;

    const lines: JournalLineInput[] = [];

    // 1. Inventory & Supplier payables
    // Debit Raw Material (gross amount)
    lines.push({
      accountCode: '10010', // Raw Material Inventory
      debit: baseCost + discountVal,
      credit: 0,
      costCenter: location,
    });

    // Credit Supplier Payable (net amount)
    lines.push({
      accountCode: '20100', // Accounts Payable - Suppliers
      debit: 0,
      credit: baseCost,
    });

    // Credit Discount if any
    if (discountVal > 0) {
      lines.push({
        accountCode: '40020', // Purchase Discount
        debit: 0,
        credit: discountVal,
      });
    }

    // 2. Hamali accrual (₹160/t profit-centre). Funding: seed bears `inventory`,
    // lorry funds `lorry`. Usage: crew is paid `crew`, company keeps `margin`.
    if (h.total > 0) {
      lines.push({
        accountCode: '10010', // Raw Material Inventory — seed's capitalised share
        debit: h.inventory,
        credit: 0,
        costCenter: location,
      });
      lines.push({
        accountCode: '10300', // Hamali Recoverable - Lorry
        debit: h.lorry,
        credit: 0,
      });
      lines.push({
        accountCode: '20200', // Outstanding Labor Liability - Hamali (crew payable)
        debit: 0,
        credit: h.crew,
        costCenter: 'Hamali Team',
      });
      lines.push({
        accountCode: '40030', // Hamali Income (company margin)
        debit: 0,
        credit: h.margin,
      });
    }

    // 3. Bag-cutting (pour into bunker) — fully crew, capitalised into the seed.
    if (bagCut > 0) {
      lines.push({
        accountCode: '10010', // Raw Material Inventory
        debit: bagCut,
        credit: 0,
        costCenter: location,
      });
      lines.push({
        accountCode: '20200', // crew payable
        debit: 0,
        credit: bagCut,
        costCenter: 'Hamali Team',
      });
    }

    // 4. Inward freight (BASE-priced POs) — capitalised into the seed.
    if (freight > 0) {
      lines.push({
        accountCode: '10010', // Raw Material Inventory
        debit: freight,
        credit: 0,
        costCenter: location,
      });
      lines.push({
        accountCode: '20230', // Freight Payable - Transporters
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
   * (Raw Material Inventory, different cost centres), and the transfer costs —
   * two hamali legs, transport, and bag-cutting — are capitalised onto the seed
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
      bagCuttingCharge: number;
      interestCharge?: number; // bank-loan carrying interest, capitalised into the seed
    }
  ) {
    const lines: JournalLineInput[] = [];

    // 1. Move the seed's existing value between silos.
    if (data.seedCostMoved > 0) {
      lines.push({ accountCode: '10010', debit: data.seedCostMoved, credit: 0, costCenter: data.toLocation });
      lines.push({ accountCode: '10010', debit: 0, credit: data.seedCostMoved, costCenter: data.fromLocation });
    }

    // 2. Hamali legs (loading + unloading), 100% company-borne.
    if (data.legCharge > 0) {
      lines.push({ accountCode: '50020', debit: data.legCharge, credit: 0, costCenter: data.toLocation }); // Factory Labor Expense
      lines.push({ accountCode: '20200', debit: 0, credit: data.legCrew, costCenter: 'Hamali Team' });
      if (data.legMargin > 0) {
        lines.push({ accountCode: '40030', debit: 0, credit: data.legMargin });
      }
    }

    // 3. Transfer transport — expensed, owed to the transporter.
    if (data.transportCharge > 0) {
      lines.push({ accountCode: '50090', debit: data.transportCharge, credit: 0, costCenter: data.toLocation }); // Transport Expense (Internal)
      lines.push({ accountCode: '20210', debit: 0, credit: data.transportCharge });
    }

    // 4. Bag-cutting at the destination bunker — fully crew, expensed.
    if (data.bagCuttingCharge > 0) {
      lines.push({ accountCode: '50030', debit: data.bagCuttingCharge, credit: 0, costCenter: data.toLocation }); // Factory Overhead
      lines.push({ accountCode: '20200', debit: 0, credit: data.bagCuttingCharge, costCenter: 'Hamali Team' });
    }

    // 5. Bank-loan carrying interest — expensed, owed to the bank.
    if (data.interestCharge && data.interestCharge > 0) {
      lines.push({ accountCode: '50080', debit: data.interestCharge, credit: 0, costCenter: data.toLocation }); // Interest Expense
      lines.push({ accountCode: '20280', debit: 0, credit: data.interestCharge }); // Bank Loan Interest Payable
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
   * Post a process→Rampalli tamarind shell transfer. The shell's transfer cost
   * (hamali crew + transport) is capitalised into Tamarind Shell Inventory; the
   * crew is owed via the hamali payable and the transport via the transfer
   * transport payable.
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
      lines.push({ accountCode: '10060', debit: data.hamaliCharge, credit: 0, costCenter: data.toLocation });
      lines.push({ accountCode: '20200', debit: 0, credit: data.hamaliCharge, costCenter: 'Hamali Team' });
    }

    if (data.transportCharge > 0) {
      lines.push({ accountCode: '10060', debit: data.transportCharge, credit: 0, costCenter: data.toLocation });
      lines.push({ accountCode: '20210', debit: 0, credit: data.transportCharge });
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
   * Post a bank-loan repayment: principal paid back out of cash.
   * Dr Bank Loan Payable (Principal) / Cr Bank/Cash.
   */
  static async postLoanRepayment(
    tx: Prisma.TransactionClient,
    repaymentId: string,
    data: { date: Date; amount: number; reference?: string | null }
  ) {
    if (data.amount <= 0) return;
    await this.postJournalEntry(tx, {
      date: data.date,
      reference: `LOAN-REPAY-${repaymentId}`,
      description: `Bank loan repayment of ₹${data.amount.toFixed(2)}${data.reference ? ` (${data.reference})` : ''}`,
      lines: [
        { accountCode: '20290', debit: data.amount, credit: 0 }, // Bank Loan Payable (Principal)
        { accountCode: '10400', debit: 0, credit: data.amount }, // Bank / Cash
      ],
    });
  }

  /**
   * Post journal entry when raw seed is sent to the mill.
   * Debits WIP Inventory, Credits Raw Material Inventory.
   */
  static async postMillingStart(
    tx: Prisma.TransactionClient,
    processingId: string,
    rawSeedCost: number,
    location: string,
    blackWeightKg: number
  ) {
    await this.postJournalEntry(tx, {
      date: new Date(),
      reference: `MILL-START-${processingId}`,
      description: `Issued ${blackWeightKg} kg of Black Seed from ${location} silo to milling`,
      lines: [
        {
          accountCode: '10020', // WIP Inventory
          debit: rawSeedCost,
          credit: 0,
          costCenter: 'Mill Line 1',
        },
        {
          accountCode: '10010', // Raw Material Inventory
          debit: 0,
          credit: rawSeedCost,
          costCenter: location,
        },
      ],
    });
  }

  /**
   * Post finished yields, byproduct credits, overhead absorption, and yield variances.
   */
  static async postMillingEnd(
    tx: Prisma.TransactionClient,
    processingId: string,
    data: {
      rawMaterialCost: number;
      pappuWeightKg: number;
      finishedPappuCost: number;
      huskWeightKg: number;
      wasteWeightKg: number;
      overheadElectricity: number;
      overheadWages: number;
      overheadMaintenance: number;
      abnormalLossCost: number;
    }
  ) {
    const lines: JournalLineInput[] = [];
    const overheadTotal =
      data.overheadElectricity + data.overheadWages + data.overheadMaintenance;

    const huskCredit = 0; // Value Husk at 0 so it does not reduce Pappu's cost.
    const wasteCredit = Math.round(data.wasteWeightKg * 1.0 * 100) / 100;

    // Debit finished goods
    lines.push({
      accountCode: '10030', // White Pappu finished goods
      debit: data.finishedPappuCost,
      credit: 0,
      costCenter: 'Warehouse Finished',
    });

    // Debit byproducts credits
    if (huskCredit > 0) {
      lines.push({
        accountCode: '10040', // Husk Inventory
        debit: huskCredit,
        credit: 0,
      });
    }
    if (wasteCredit > 0) {
      lines.push({
        accountCode: '10050', // Waste Inventory
        debit: wasteCredit,
        credit: 0,
      });
    }

    // Debit abnormal yield loss variance
    if (data.abnormalLossCost > 0) {
      lines.push({
        accountCode: '50040', // Yield Variance Loss
        debit: data.abnormalLossCost,
        credit: 0,
        costCenter: 'Mill Line 1',
      });
    }

    // Credit WIP Inventory (amount issued + abnormal loss)
    lines.push({
      accountCode: '10020', // WIP Inventory
      debit: 0,
      credit: data.rawMaterialCost,
      costCenter: 'Mill Line 1',
    });

    // Credit Overhead absorption
    if (overheadTotal > 0) {
      lines.push({
        accountCode: '50030', // Factory Overhead Expense (Absorption Credit)
        debit: 0,
        credit: overheadTotal,
        costCenter: 'Mill Line 1',
      });
    }

    await this.postJournalEntry(tx, {
      date: new Date(),
      reference: `MILL-END-${processingId}`,
      description: `Milling completed: Produced ${data.pappuWeightKg} kg Pappu, ${data.huskWeightKg} kg Husk, and ${data.wasteWeightKg} kg Waste`,
      lines,
    });
  }

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
      brokerageAmount?: number;
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
        accountCode: '20250', // Lorry Owner Payable - Freight
        debit: 0,
        credit: lorryOwner,
      });
      if (companyHamali > 0) {
        lines.push({
          accountCode: '50070', // Loading Hamali Expense (Selling) — our share
          debit: companyHamali,
          credit: 0,
          costCenter: data.product,
        });
      }
      if (retention > 0) {
        lines.push({
          accountCode: '20260', // Freight Retention Held (released at delivery)
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
    }

    // Brokerage accrual if applicable
    if (data.brokerageAmount && data.brokerageAmount > 0) {
      lines.push({
        accountCode: '50060', // Brokerage Expense
        debit: data.brokerageAmount,
        credit: 0,
      });
      lines.push({
        accountCode: '20240', // Brokerage Payable
        debit: 0,
        credit: data.brokerageAmount,
      });
    }

    await this.postJournalEntry(tx, {
      date: new Date(),
      reference: `SALE-${saleOrderId}`,
      description: `Sale dispatch of ${data.weightKg} kg ${data.product} to buyer ${data.buyerName}`,
      lines,
    });
  }

  /**
   * On delivery (kata slip received at REACHED), release the held freight
   * retention to Surya Roadlines: Dr Freight Retention Held / Cr Surya Roadlines.
   */
  static async postFreightRetentionRelease(
    tx: Prisma.TransactionClient,
    saleOrderId: string,
    amount: number
  ) {
    if (amount <= 0) return;
    await this.postJournalEntry(tx, {
      date: new Date(),
      reference: `FREIGHT-RELEASE-${saleOrderId}`,
      description: `Released ₹${amount.toFixed(2)} freight retention to Surya Roadlines on delivery`,
      lines: [
        { accountCode: '20260', debit: amount, credit: 0 }, // Freight Retention Held
        { accountCode: '20255', debit: 0, credit: amount }, // Surya Roadlines Payable
      ],
    });
  }

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

  static async postInternalWeightProfit(
    tx: Prisma.TransactionClient,
    saleOrderId: string,
    data: {
      buyerName: string;
      product: string;
      profitWeightKg: number;
      amount: number;
    }
  ) {
    if (data.amount <= 0) return;
    
    await this.postJournalEntry(tx, {
      date: new Date(),
      reference: `IWP-${saleOrderId}`,
      description: `Internal weight profit of ${data.profitWeightKg} kg on delivery to ${data.buyerName}`,
      lines: [
        {
          accountCode: '50010', // Cost of Goods Sold (Debit increases the expense)
          debit: data.amount,
          credit: 0,
          costCenter: data.product,
        },
        {
          accountCode: '40040', // Internal Weight Profit (Credit increases revenue)
          debit: 0,
          credit: data.amount,
          costCenter: data.product,
        },
      ],
    });
  }

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
      reference?: string;
      description?: string;
    }
  ) {
    let debitAccount = '50030'; // Default: Factory Overhead Expense for OTHER
    let partyRef = '';
    if (data.type === 'SUPPLIER') {
      debitAccount = '20100'; // Accounts Payable - Suppliers
      partyRef = data.partyName || '';
    } else if (data.type === 'TRANSPORTER') {
      debitAccount = '20230'; // Freight Payable - Transporters
      partyRef = data.lorryNumber ? `Lorry ${data.lorryNumber}` : '';
    } else if (data.type === 'BROKER') {
      debitAccount = '20240'; // Brokerage Payable
      partyRef = data.brokerName || '';
    }

    const lines: JournalLineInput[] = [
      {
        accountCode: debitAccount,
        debit: data.amount,
        credit: 0,
        costCenter: data.type === 'TRANSPORTER' ? data.lorryNumber : undefined,
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
      description: `Payment to ${data.type} ${partyRef}. Ref: ${data.reference || '—'}. ${data.description || ''}`.trim(),
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
      reference?: string;
      description?: string;
    }
  ) {
    let creditAccount = '40010'; // Default: Sales Revenue for OTHER
    let partyRef = '';
    if (data.type === 'BUYER') {
      creditAccount = '10100'; // Accounts Receivable - Buyers
      partyRef = data.partyName || '';
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

    await this.postJournalEntry(tx, {
      date: data.date,
      reference: `RECEIPT-${receiptId}`,
      description: `Receipt from ${data.type} ${partyRef}. Ref: ${data.reference || '—'}. ${data.description || ''}`.trim(),
      lines,
    });
  }
}
