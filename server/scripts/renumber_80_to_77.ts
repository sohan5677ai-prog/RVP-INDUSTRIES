import { prisma } from '../src/lib/prisma.js';

const DISPATCH_ID = 'cmrkdpdsw0005s8t88qtp09e3'; // SLV / AP04TT0099 HUSK
const TARGET_SEQ = 77;
const FY = '2026-27';
const TARGET_NUMBER = 'RVP/77/26-27';
const APPLY = process.argv.includes('--apply');

async function main() {
  const d = await prisma.saleDispatch.findUnique({
    where: { id: DISPATCH_ID },
    include: { saleOrder: { include: { buyer: true } } },
  });
  if (!d) { console.error('dispatch not found'); return; }
  console.log(`Target: ${d.saleOrder?.buyer?.name} / ${d.vehicleNumber} / ${d.saleOrder?.product}`);
  console.log(`Current: ${d.invoiceNumber} (seq ${d.invoiceSeq}, fy ${d.invoiceFy})`);

  // Safety: 77 must be free.
  const clash = await prisma.saleDispatch.findFirst({ where: { invoiceFy: FY, invoiceSeq: TARGET_SEQ } });
  if (clash) { console.error(`ABORT: seq 77 already used by ${clash.id} (${clash.invoiceNumber})`); return; }

  console.log(`New:     ${TARGET_NUMBER} (seq ${TARGET_SEQ}, fy ${FY})`);
  if (!APPLY) { console.log('\nDRY RUN. Re-run with --apply.'); return; }

  await prisma.saleDispatch.update({
    where: { id: DISPATCH_ID },
    data: { invoiceNumber: TARGET_NUMBER, invoiceSeq: TARGET_SEQ, invoiceFy: FY },
  });

  const agg = await prisma.saleDispatch.aggregate({ where: { invoiceFy: FY }, _max: { invoiceSeq: true } });
  console.log('\nAPPLIED. Max seq now', agg._max.invoiceSeq, '=> next raise -> RVP/' + ((agg._max.invoiceSeq ?? 0) + 1) + '/26-27');
}
main().finally(() => prisma.$disconnect());
