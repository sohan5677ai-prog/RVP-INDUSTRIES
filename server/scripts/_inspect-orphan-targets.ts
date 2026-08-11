// Throwaway read-only inspection of the invoices the 3 on-account receipts settle.
import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';

const INVOICES = ['RVP/109/26-27', 'RVP/63/26-27', 'RVP/64/26-27', 'RVP/66/26-27', 'RVP/67/26-27', 'RVP/74/26-27', 'RVP/75/26-27'];

async function main() {
  const ds = await prisma.saleDispatch.findMany({
    where: { invoiceNumber: { in: INVOICES } },
    include: { saleOrder: { select: { ratePerKg: true, gstExempt: true, buyer: { select: { name: true } } } } },
  });
  for (const d of ds) {
    const rate = Number(d.saleOrder.ratePerKg);
    const base = d.weightKg * rate;
    const bill = Math.round(base + Number(d.gstAmount ?? 0));
    console.log({
      invoice: d.invoiceNumber,
      buyer: d.saleOrder.buyer?.name,
      id: d.id,
      weightKg: d.weightKg,
      rate,
      base,
      gstAmount: Number(d.gstAmount ?? 0),
      bill,
      gstExempt: d.saleOrder.gstExempt,
      shortageKg: d.shortageKg,
      creditNoteAmount: d.creditNoteAmount ? Number(d.creditNoteAmount) : null,
      tdsOnDispatch: d.tdsAmount ? Number(d.tdsAmount) : null,
      tds01pct: Math.round(base * 0.001),
      shortageValueBase: d.shortageKg ? Math.round(Number(d.shortageKg) * rate) : 0,
    });
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
