/**
 * Park invoice numbers that were issued and then cancelled outside the ERP, so
 * they stay nil for good.
 *
 * GST spends a document number the moment it is issued - the NIC portal answers
 * a second IRN on the same number with error 2278 ("IRN is already generated and
 * is cancelled for this Document number"). Numbers raised and then withdrawn
 * inside the ERP are burnt automatically when the dispatch is undone; this
 * script is for the ones whose shipment rows are already gone, or that were
 * cancelled directly on the portal.
 *
 * Any shipment still sitting on one of these numbers is moved forward to the
 * next free number - it never got a valid IRN, so renumbering is the only way it
 * can be e-invoiced at all.
 *
 * Usage (from server/):
 *   node --import tsx prisma/burnInvoiceNumbers.ts 187 188 189
 *   node --import tsx prisma/burnInvoiceNumbers.ts --series URS --fy 2026-27 7
 */
import { PrismaClient } from '@prisma/client';
import { indianFinancialYear } from '../src/lib/invoice.js';
import { nextInvoiceSeq, formatInvoiceNumber } from '../src/lib/invoiceSeries.js';

const prisma = new PrismaClient();

function parseArgs(argv: string[]) {
  let series = 'RVP';
  let fy = indianFinancialYear(new Date());
  let reason = 'Cancelled on the GST portal - number kept nil';
  const seqs: number[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--series') series = argv[++i];
    else if (a === '--fy') fy = argv[++i];
    else if (a === '--reason') reason = argv[++i];
    else {
      const n = Number(a);
      if (!Number.isInteger(n) || n < 1) throw new Error(`Not an invoice sequence number: ${a}`);
      seqs.push(n);
    }
  }
  if (seqs.length === 0) throw new Error('Pass at least one invoice sequence number, e.g. 187 188 189');
  return { series, fy, reason, seqs };
}

async function main() {
  const { series, fy, reason, seqs } = parseArgs(process.argv.slice(2));
  const profile = await prisma.companyProfile.findUnique({ where: { id: 'default' } });
  const prefix = series === 'URS' ? 'URS' : (profile?.invoicePrefix || 'RVP');

  // Burn every requested number first, then move any stranded shipments - doing
  // it one number at a time would walk a holder through the numbers still to be
  // burnt (187 -> 188 -> 189) instead of straight past them.
  const holders: { holder: { id: string; irn: string | null; irnStatus: string | null; saleOrder: { buyer: { name: string } } }; invoiceNumber: string }[] = [];
  for (const seq of seqs) {
    const invoiceNumber = formatInvoiceNumber(prefix, seq, fy);
    // A shipment still holding this number has to move: the number is dead at NIC.
    const holder = await prisma.saleDispatch.findFirst({
      where: { invoiceFy: fy, invoiceSeries: series, invoiceSeq: seq },
      include: { saleOrder: { include: { buyer: true } } },
    });
    if (holder) holders.push({ holder, invoiceNumber });

    await prisma.voidInvoiceNumber.upsert({
      where: { invoiceFy_invoiceSeq_invoiceSeries: { invoiceFy: fy, invoiceSeq: seq, invoiceSeries: series } },
      create: {
        invoiceSeries: series,
        invoiceFy: fy,
        invoiceSeq: seq,
        invoiceNumber,
        invoiceDate: holder?.invoiceDate ?? null,
        buyerName: holder?.saleOrder.buyer.name ?? null,
        reason,
      },
      update: {},
    });
    console.log(`burnt  ${invoiceNumber}`);
  }

  for (const { holder, invoiceNumber } of holders) {
    if (holder.irn && holder.irnStatus !== 'CANCELLED') {
      console.log(`  !! ${invoiceNumber} carries a live IRN (${holder.irn}) - cancel it on the portal first; left untouched.`);
      continue;
    }
    const floor = series === 'URS' ? (profile?.nextUrsInvoiceSeq ?? 1) : (profile?.nextInvoiceSeq ?? 1);
    const newSeq = await nextInvoiceSeq(prisma, series, fy, floor);
    const newNumber = formatInvoiceNumber(prefix, newSeq, fy);
    await prisma.saleDispatch.update({
      where: { id: holder.id },
      data: { invoiceSeq: newSeq, invoiceNumber: newNumber },
    });
    console.log(`  moved ${holder.saleOrder.buyer.name}'s shipment ${invoiceNumber} -> ${newNumber}`);
  }

  const next = await nextInvoiceSeq(
    prisma,
    series,
    fy,
    series === 'URS' ? (profile?.nextUrsInvoiceSeq ?? 1) : (profile?.nextInvoiceSeq ?? 1),
  );
  console.log(`next ${series} invoice: ${formatInvoiceNumber(prefix, next, fy)}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
