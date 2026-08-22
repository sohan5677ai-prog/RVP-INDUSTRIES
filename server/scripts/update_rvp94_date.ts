import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const prisma = new PrismaClient();

async function main() {
  const dispatchId = 'cms4wg9ae0003cw2d6ytvrjs1';

  // 1. Fetch current state
  const beforeDispatch = await prisma.saleDispatch.findUnique({
    where: { id: dispatchId },
    include: {
      saleOrder: {
        include: {
          buyer: true
        }
      }
    }
  });

  if (!beforeDispatch) {
    throw new Error(`Dispatch ${dispatchId} not found!`);
  }

  const beforeJE = await prisma.journalEntry.findFirst({
    where: { reference: `SALE-${dispatchId}` },
    include: { lines: true }
  });

  console.log('=== BEFORE UPDATE ===');
  console.log('Dispatch:', {
    id: beforeDispatch.id,
    invoiceNumber: beforeDispatch.invoiceNumber,
    vehicleNumber: beforeDispatch.vehicleNumber,
    dispatchDate: beforeDispatch.dispatchDate,
    invoiceDate: beforeDispatch.invoiceDate,
    deliveredDate: beforeDispatch.deliveredDate,
    saleDate: beforeDispatch.saleOrder.saleDate
  });
  console.log('Journal Entry:', beforeJE ? {
    id: beforeJE.id,
    date: beforeJE.date,
    reference: beforeJE.reference,
    description: beforeJE.description
  } : null);

  // Backup state
  const backup = {
    timestamp: new Date().toISOString(),
    dispatch: beforeDispatch,
    journalEntry: beforeJE
  };

  const backupFile = path.join(__dirname, `backup_rvp94_date_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2));
  console.log(`Backup saved to ${backupFile}`);

  // 2. Perform update
  const newDispatchDate = new Date('2026-07-25T00:00:00.000Z');
  const newInvoiceDate = new Date('2026-07-25T16:58:17.591Z');
  const newJEDate = new Date('2026-07-25T16:58:06.491Z');

  const updatedDispatch = await prisma.saleDispatch.update({
    where: { id: dispatchId },
    data: {
      dispatchDate: newDispatchDate,
      invoiceDate: newInvoiceDate
    }
  });

  let updatedJE = null;
  if (beforeJE) {
    updatedJE = await prisma.journalEntry.update({
      where: { id: beforeJE.id },
      data: {
        date: newJEDate
      }
    });
  }

  console.log('=== AFTER UPDATE ===');
  console.log('Dispatch:', {
    id: updatedDispatch.id,
    invoiceNumber: updatedDispatch.invoiceNumber,
    dispatchDate: updatedDispatch.dispatchDate,
    invoiceDate: updatedDispatch.invoiceDate,
    deliveredDate: updatedDispatch.deliveredDate
  });
  console.log('Journal Entry:', updatedJE ? {
    id: updatedJE.id,
    date: updatedJE.date,
    reference: updatedJE.reference
  } : null);
}

main().catch(console.error).finally(() => prisma.$disconnect());
