import { prisma } from '../lib/prisma.js';
import { Prisma } from '@prisma/client';

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
    const hamali = Number(p.hamaliCharge);
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

    // 2. Hamali Accrual
    if (hamali > 0) {
      lines.push({
        accountCode: '50020', // Factory Labor Expense
        debit: hamali,
        credit: 0,
        costCenter: 'Hamali Team',
      });
      lines.push({
        accountCode: '20200', // Outstanding Labor Liability - Hamali
        debit: 0,
        credit: hamali,
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

    const huskCredit = Math.round(data.huskWeightKg * 1.5 * 100) / 100;
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
   * Post Sales revenue, Accounts Receivable, inventory finished deduction, and COGS.
   */
  static async postSaleDispatch(
    tx: Prisma.TransactionClient,
    dispatchId: string,
    data: {
      buyerName: string;
      invoiceAmount: number;
      cogsAmount: number;
      dispatchWeightKg: number;
    }
  ) {
    await this.postJournalEntry(tx, {
      date: new Date(),
      reference: `SALE-DISPATCH-${dispatchId}`,
      description: `Invoice dispatch of ${data.dispatchWeightKg} kg White Pappu to buyer ${data.buyerName}`,
      lines: [
        {
          accountCode: '10100', // Accounts Receivable - Buyers
          debit: data.invoiceAmount,
          credit: 0,
        },
        {
          accountCode: '40010', // Sales Revenue
          debit: 0,
          credit: data.invoiceAmount,
        },
        {
          accountCode: '50010', // Cost of Goods Sold
          debit: data.cogsAmount,
          credit: 0,
        },
        {
          accountCode: '10030', // Finished White Pappu Inventory
          debit: 0,
          credit: data.cogsAmount,
          costCenter: 'Warehouse Finished',
        },
      ],
    });
  }

  /**
   * Post sale shortage credit note and claim transit losses from transport.
   */
  static async postSaleDispute(
    tx: Prisma.TransactionClient,
    dispatchId: string,
    data: {
      buyerName: string;
      creditNoteAmount: number;
      shortageKg: number;
    }
  ) {
    if (data.creditNoteAmount <= 0) return;

    // Split: 0.2% atmospheric loss is absorbed as yield expense; anything above is Transit Loss Claim
    // Wait, let's claim the entire amount from transit loss claim receivable or split it simply:
    // Debit: Transit Loss Claim Receivable (Asset) - to claim from the transport company
    // Credit: Accounts Receivable - Buyers (reducing customer balance)
    await this.postJournalEntry(tx, {
      date: new Date(),
      reference: `CN-${dispatchId}`,
      description: `Credit Note issued to ${data.buyerName} for shortage discrepancy of ${data.shortageKg} kg`,
      lines: [
        {
          accountCode: '10200', // Transit Loss Claim Receivable
          debit: data.creditNoteAmount,
          credit: 0,
        },
        {
          accountCode: '10100', // Accounts Receivable - Buyers
          debit: 0,
          credit: data.creditNoteAmount,
        },
      ],
    });
  }
}
