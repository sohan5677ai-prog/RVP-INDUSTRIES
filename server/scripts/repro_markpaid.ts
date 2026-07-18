import { prisma } from '../src/lib/prisma.js';
import { LedgerService } from '../src/services/ledger.service.js';

// Repro of markDispatchPaid for a given dispatch id, but ALWAYS rolls back so
// nothing is persisted. Prints the real error if the transaction throws.
const dispatchId = process.argv[2];
if (!dispatchId) { console.error('usage: tsx repro_markpaid.ts <dispatchId>'); process.exit(1); }

const data = {
  date: new Date(),
  amount: 1000,      // force the receipt branch
  tdsAmount: 100,    // force the TDS branch
  shortageAmount: 50 // force the shortage branch
};

async function main() {
  const dispatch = await prisma.saleDispatch.findUnique({
    where: { id: dispatchId },
    include: { saleOrder: { include: { buyer: true } } },
  });
  if (!dispatch) { console.error('dispatch not found'); return; }
  const buyer = dispatch.saleOrder.buyer;
  console.log('buyer =', buyer && buyer.name, 'buyerId=', buyer && buyer.id);

  try {
    await prisma.$transaction(async (tx) => {
      if (data.amount > 0) {
        const createdReceipt = await tx.receipt.create({
          data: { date: data.date, amount: data.amount, type: 'BUYER', partyId: buyer.id,
            description: `Payment for Invoice ${dispatch.invoiceNumber ?? dispatch.id}` },
        });
        await LedgerService.postReceipt(tx, createdReceipt.id, {
          date: data.date, amount: data.amount, type: 'BUYER', partyName: buyer.name,
          description: `Payment for Invoice ${dispatch.invoiceNumber ?? dispatch.id}` });
        console.log('  step1 receipt OK');
      }
      if (data.tdsAmount > 0) {
        await LedgerService.postSaleTdsDeduction(tx, dispatch.id, { date: data.date, buyerName: buyer.name, tdsAmount: data.tdsAmount });
        console.log('  step2 tds OK');
      }
      if (data.shortageAmount > 0) {
        await LedgerService.postSaleShortageDeduction(tx, dispatch.id, { date: data.date, buyerName: buyer.name, shortageAmount: data.shortageAmount });
        console.log('  step3 shortage OK');
      }
      await tx.saleDispatch.update({ where: { id: dispatch.id }, data: {
        tdsAmount: data.tdsAmount,
        creditNoteAmount: data.shortageAmount > 0 ? data.shortageAmount : dispatch.creditNoteAmount },
      });
      console.log('  step4 update OK');
      throw new Error('__ROLLBACK__'); // never persist
    });
  } catch (e: any) {
    if (e?.message === '__ROLLBACK__') { console.log('ALL STEPS SUCCEEDED (rolled back, nothing saved)'); }
    else { console.error('REAL ERROR =>', e); }
  }
}

main().finally(() => prisma.$disconnect());
