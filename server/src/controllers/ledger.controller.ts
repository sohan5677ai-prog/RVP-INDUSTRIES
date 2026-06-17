import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { InventoryService } from '../services/inventory.service.js';

export async function listAccounts(req: Request, res: Response) {
  const accounts = await prisma.account.findMany({
    orderBy: { code: 'asc' },
    include: {
      lines: {
        include: { journalEntry: true }
      }
    }
  });

  // Calculate actual balances: Debit - Credit for Assets/Expenses, Credit - Debit for Liabilities/Equity/Revenues
  const formatted = accounts.map((a) => {
    const totalDebits = a.lines.reduce((sum, l) => sum + Number(l.debit), 0);
    const totalCredits = a.lines.reduce((sum, l) => sum + Number(l.credit), 0);
    
    let balance = 0;
    if (a.type === 'ASSET' || a.type === 'EXPENSE') {
      balance = totalDebits - totalCredits;
    } else {
      balance = totalCredits - totalDebits;
    }

    return {
      id: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
      debits: totalDebits,
      credits: totalCredits,
      balance,
    };
  });

  res.json(formatted);
}

export async function listJournalEntries(req: Request, res: Response) {
  const entries = await prisma.journalEntry.findMany({
    orderBy: { date: 'desc' },
    include: {
      lines: {
        include: {
          account: true
        }
      }
    }
  });
  res.json(entries);
}

export async function listSilos(req: Request, res: Response) {
  const silos = await InventoryService.listSilos();
  res.json(silos);
}
