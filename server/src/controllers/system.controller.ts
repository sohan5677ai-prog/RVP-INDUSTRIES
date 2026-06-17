import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';

export async function clearTransactions(_req: Request, res: Response) {
  await prisma.$transaction([
    prisma.pappuPrice.deleteMany(),
    prisma.processing.deleteMany(),
    prisma.weightVerification.deleteMany(),
    prisma.purchase.deleteMany(),
    prisma.stockIn.deleteMany(),
    prisma.purchaseOrder.deleteMany(),
    prisma.saleDispatch.deleteMany(),
    prisma.saleOrder.deleteMany(),
    prisma.journalLine.deleteMany(),
    prisma.journalEntry.deleteMany(),
    prisma.siloInventory.deleteMany(),
  ]);
  res.json({ message: 'All transactional data, ledger logs, and inventory balances have been cleared. You are starting fresh!' });
}
