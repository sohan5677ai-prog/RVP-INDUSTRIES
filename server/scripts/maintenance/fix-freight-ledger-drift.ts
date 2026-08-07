/**
 * Reconcile sale journal entries whose Freight Outward debit disagrees with the
 * dispatch it was posted for.
 *
 * These six dispatches had their `freightCharge` corrected directly in the DB at
 * some earlier point (no code path writes that column after creation) without the
 * matching journal entry being re-posted, so 50050 Freight Outward and 20250
 * Lorry Owner Payable were both left at the original per-destination figure.
 * The dispatch is the correct side - it is what the Pappu margin and Freight Dues
 * read - so the ledger is brought down to it.
 *
 * Hamali, kata and retention are weight-based and unaffected, so the whole delta
 * belongs to the lorry owner's payable and the entry stays balanced. Same shape
 * as fix-lorry-freight.ts.
 *
 * Run `npx tsx scripts/maintenance/fix-freight-ledger-drift.ts` for a dry run,
 * add `--apply` to write.
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const money = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function run() {
  const dispatches = await prisma.saleDispatch.findMany({
    select: {
      id: true,
      vehicleNumber: true,
      dispatchDate: true,
      weightKg: true,
      freightCharge: true,
      saleOrder: { select: { product: true, buyer: { select: { name: true } } } },
    },
    orderBy: { dispatchDate: 'asc' },
  });

  type Plan = {
    d: (typeof dispatches)[number];
    jeId: string;
    frtLineId: string;
    payLineId: string;
    payCode: string;
    frtFrom: number;
    frtTo: number;
    payFrom: number;
    payTo: number;
    delta: number;
  };
  const plans: Plan[] = [];
  const problems: string[] = [];

  for (const d of dispatches) {
    const je = await prisma.journalEntry.findFirst({
      where: { reference: `SALE-${d.id}` },
      include: { lines: { include: { account: true } } },
    });
    if (!je) continue;
    const frtLine = je.lines.find((l) => l.account.code === '50050');
    if (!frtLine) continue;

    const want = Number(d.freightCharge);
    const have = Number(frtLine.debit);
    const delta = Math.round((want - have) * 100) / 100;
    if (delta === 0) continue;

    const payLine = je.lines.find((l) => l.account.code === '20250' || l.account.code === '20260');
    if (!payLine) {
      problems.push(`${d.vehicleNumber} ${d.dispatchDate.toISOString().slice(0, 10)}: no 20250/20260 line to absorb the delta`);
      continue;
    }
    const payFrom = Number(payLine.credit);
    if (payFrom + delta < 0) {
      problems.push(
        `${d.vehicleNumber} ${d.dispatchDate.toISOString().slice(0, 10)}: delta ${delta} would push the lorry payable negative (${payFrom}) - resolve by hand`,
      );
      continue;
    }
    // Entry must be balanced going in, or moving one line each way is not safe.
    const dr = je.lines.reduce((s, l) => s + Number(l.debit), 0);
    const cr = je.lines.reduce((s, l) => s + Number(l.credit), 0);
    if (Math.abs(dr - cr) > 0.01) {
      problems.push(`${d.vehicleNumber} ${d.dispatchDate.toISOString().slice(0, 10)}: entry already unbalanced (Dr ${dr} / Cr ${cr}) - resolve by hand`);
      continue;
    }

    plans.push({
      d,
      jeId: je.id,
      frtLineId: frtLine.id,
      payLineId: payLine.id,
      payCode: payLine.account.code,
      frtFrom: have,
      frtTo: want,
      payFrom,
      payTo: Math.round((payFrom + delta) * 100) / 100,
      delta,
    });
  }

  console.log(APPLY ? '=== APPLYING ===' : '=== DRY RUN (add --apply to write) ===');
  console.log('');
  console.log(['LORRY', 'DISPATCH_DT', 'PRODUCT', 'BUYER', 'WT', '50050', 'PAYABLE', 'DELTA'].join(' | '));
  for (const p of plans) {
    console.log(
      [
        p.d.vehicleNumber,
        p.d.dispatchDate.toISOString().slice(0, 10),
        p.d.saleOrder.product,
        p.d.saleOrder.buyer.name.trim(),
        `${(p.d.weightKg / 1000).toFixed(2)}t`,
        `${money(p.frtFrom)} -> ${money(p.frtTo)}`,
        `${p.payCode} ${money(p.payFrom)} -> ${money(p.payTo)}`,
        money(p.delta),
      ].join(' | '),
    );
  }

  const totalDelta = plans.reduce((s, p) => s + p.delta, 0);
  console.log('');
  console.log(`Entries to adjust: ${plans.length}   net change to Freight Outward: ${money(totalDelta)}`);
  if (problems.length) {
    console.log('');
    console.log('NOT APPLIED:');
    for (const p of problems) console.log('  - ' + p);
  }

  if (!APPLY || plans.length === 0) return;

  for (const p of plans) {
    await prisma.$transaction(async (tx) => {
      await tx.journalLine.update({ where: { id: p.frtLineId }, data: { debit: new Prisma.Decimal(p.frtTo) } });
      await tx.journalLine.update({ where: { id: p.payLineId }, data: { credit: new Prisma.Decimal(p.payTo) } });
    });
  }

  console.log('');
  console.log(`Journal entries adjusted: ${plans.length}`);
}

run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
