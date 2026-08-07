/**
 * One-off correction: stamp each lorry's ACTUAL negotiated freight onto its sale
 * dispatch, from the transporter's confirmation sheet.
 *
 * The dispatches were booked at the standing per-destination rate (Surat ₹2,800/t
 * → ₹84,000 for 30 t), but the freight actually agreed per trip differs. Because
 * the Pappu margin nets ACTUAL dispatch freight out of the sale price (see
 * inventory.controller `actualFreight`), the overstated freight was eating margin.
 *
 * Two writes per lorry, kept in one transaction:
 *   1. SaleDispatch.freightCharge  → the actual amount (drives margin + Freight Dues)
 *   2. the dispatch's journal entry → 50050 Freight Outward debit and the
 *      20250 Lorry Owner Payable (or 20260 KNM) credit move by the same delta.
 *      Hamali / kata / retention are weight-based and unchanged, so the whole
 *      delta belongs to the lorry owner and the entry stays balanced.
 *
 * Run `npx tsx scripts/maintenance/fix-lorry-freight.ts` for a dry run,
 * add `--apply` to write.
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const MAX_DATE_DRIFT_DAYS = 7;

// Actual lorry freight per trip, from the transporter's sheet.
const SHEET: { lorry: string; date: string; to: string; freight: number }[] = [
  { lorry: 'GJ04AX6555', date: '2026-08-01', to: 'Surat', freight: 80000 },
  { lorry: 'AP05TG4959', date: '2026-08-01', to: 'Surat', freight: 80000 },
  { lorry: 'GJ04AW7409', date: '2026-07-29', to: 'Surat', freight: 80000 },
  { lorry: 'TN34AZ5349', date: '2026-07-27', to: 'Surat', freight: 80000 },
  { lorry: 'TN86F2242', date: '2026-07-28', to: 'Surat', freight: 80000 },
  { lorry: 'TN52M4755', date: '2026-07-19', to: 'Silvassa', freight: 80000 },
  { lorry: 'TN52P5108', date: '2026-07-21', to: 'Silvassa', freight: 80000 },
  { lorry: 'AP39T8217', date: '2026-07-18', to: 'Surat', freight: 80000 },
  { lorry: 'AP39VF0066', date: '2026-07-19', to: 'Silvassa', freight: 80000 },
  { lorry: 'GJ03BV5571', date: '2026-08-03', to: 'Surat', freight: 80000 },
  { lorry: 'TN28BM9403', date: '2026-07-01', to: 'Surat', freight: 80000 },
  { lorry: 'GJ06AX4056', date: '2026-06-29', to: 'Surat', freight: 80000 },
  { lorry: 'TN52AC2251', date: '2026-06-27', to: 'Shahada', freight: 84000 },
  { lorry: 'TN52AH1074', date: '2026-07-31', to: 'Surat', freight: 92000 },
  { lorry: 'AP39UF5999', date: '2026-06-13', to: 'Surat', freight: 80000 },
  { lorry: 'TN52P0705', date: '2026-06-11', to: 'Surat', freight: 80000 },
  { lorry: 'TN86A6588', date: '2026-08-02', to: 'Surat', freight: 80000 },
  { lorry: 'TN52J9102', date: '2026-06-05', to: 'Surat', freight: 80000 },
  { lorry: 'TN90H8199', date: '2026-05-30', to: 'Surat', freight: 78000 },
  { lorry: 'TN52M0483', date: '2026-05-22', to: 'Surat', freight: 76000 },
  { lorry: 'TN52AE6064', date: '2026-05-20', to: 'Shahada', freight: 80500 },
  { lorry: 'TN83E2399', date: '2026-05-20', to: 'Surat', freight: 73000 },
  { lorry: 'TN52AF4353', date: '2026-05-17', to: 'Shahada', freight: 80500 },
];

const norm = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const days = (a: Date, b: Date) => Math.abs(a.getTime() - b.getTime()) / 86_400_000;
const money = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function run() {
  const dispatches = await prisma.saleDispatch.findMany({
    where: { vehicleNumber: { not: null } },
    select: {
      id: true,
      vehicleNumber: true,
      dispatchDate: true,
      weightKg: true,
      freightCharge: true,
      transportProvider: true,
      saleOrder: { select: { product: true, destination: true, buyer: { select: { name: true, destination: true } } } },
    },
  });

  type Plan = {
    lorry: string;
    sheetDate: string;
    dispatch: (typeof dispatches)[number];
    from: number;
    to: number;
    delta: number;
    drift: number;
  };
  const plans: Plan[] = [];
  const problems: string[] = [];

  for (const row of SHEET) {
    const want = new Date(`${row.date}T00:00:00.000Z`);
    const candidates = dispatches.filter((d) => norm(d.vehicleNumber) === norm(row.lorry));
    if (candidates.length === 0) {
      problems.push(`${row.lorry} ${row.date}: no dispatch with this vehicle number`);
      continue;
    }
    const scored = candidates
      .map((d) => ({ d, drift: days(d.dispatchDate, want) }))
      .sort((a, b) => a.drift - b.drift);
    const best = scored[0];
    if (best.drift > MAX_DATE_DRIFT_DAYS) {
      problems.push(
        `${row.lorry} ${row.date}: nearest dispatch is ${best.d.dispatchDate.toISOString().slice(0, 10)} (${best.drift.toFixed(0)}d away) - skipped`,
      );
      continue;
    }
    if (scored.length > 1 && scored[1].drift === best.drift) {
      problems.push(`${row.lorry} ${row.date}: two dispatches equally close - skipped, resolve by hand`);
      continue;
    }
    if (plans.some((p) => p.dispatch.id === best.d.id)) continue; // sheet lists some lorries twice
    const from = Number(best.d.freightCharge);
    plans.push({
      lorry: row.lorry,
      sheetDate: row.date,
      dispatch: best.d,
      from,
      to: row.freight,
      delta: Math.round((row.freight - from) * 100) / 100,
      drift: best.drift,
    });
  }

  const changes = plans.filter((p) => p.delta !== 0);
  console.log(APPLY ? '=== APPLYING ===' : '=== DRY RUN (add --apply to write) ===');
  console.log('');
  console.log(
    ['LORRY', 'SHEET_DT', 'DISPATCH_DT', 'DRIFT', 'PRODUCT', 'BUYER', 'DEST', 'WT', 'OLD_FRT', 'NEW_FRT', 'DELTA'].join(' | '),
  );
  for (const p of plans.sort((a, b) => a.dispatch.dispatchDate.getTime() - b.dispatch.dispatchDate.getTime())) {
    const d = p.dispatch;
    console.log(
      [
        p.lorry,
        p.sheetDate,
        d.dispatchDate.toISOString().slice(0, 10),
        `${p.drift.toFixed(0)}d`,
        d.saleOrder.product,
        d.saleOrder.buyer.name.trim(),
        d.saleOrder.destination ?? d.saleOrder.buyer.destination ?? '-',
        `${(d.weightKg / 1000).toFixed(2)}t`,
        money(p.from),
        money(p.to),
        p.delta === 0 ? 'no change' : money(p.delta),
      ].join(' | '),
    );
  }

  const totalDelta = changes.reduce((s, p) => s + p.delta, 0);
  console.log('');
  console.log(`Lorries matched: ${plans.length}   changing: ${changes.length}   unchanged: ${plans.length - changes.length}`);
  console.log(`Net freight change: ${money(totalDelta)}  (margin moves by ${money(-totalDelta)})`);
  if (problems.length) {
    console.log('');
    console.log('NOT APPLIED:');
    for (const p of problems) console.log('  - ' + p);
  }

  if (!APPLY || changes.length === 0) return;

  let jeUpdated = 0;
  let jeMissing = 0;
  for (const p of changes) {
    await prisma.$transaction(async (tx) => {
      await tx.saleDispatch.update({
        where: { id: p.dispatch.id },
        data: { freightCharge: new Prisma.Decimal(p.to) },
      });

      // Move the ledger by the same delta: Freight Outward (expense) and the
      // lorry owner's payable. Everything else in the split is weight-based.
      const je = await tx.journalEntry.findFirst({
        where: { reference: `SALE-${p.dispatch.id}` },
        include: { lines: { include: { account: true } } },
      });
      if (!je) {
        jeMissing++;
        return;
      }
      const frtLine = je.lines.find((l) => l.account.code === '50050');
      const payLine = je.lines.find((l) => l.account.code === '20250' || l.account.code === '20260');
      if (!frtLine || !payLine) {
        jeMissing++;
        return;
      }
      await tx.journalLine.update({
        where: { id: frtLine.id },
        data: { debit: new Prisma.Decimal(Number(frtLine.debit) + p.delta) },
      });
      await tx.journalLine.update({
        where: { id: payLine.id },
        data: { credit: new Prisma.Decimal(Number(payLine.credit) + p.delta) },
      });
      jeUpdated++;
    });
  }

  console.log('');
  console.log(`Dispatches updated: ${changes.length}   journal entries adjusted: ${jeUpdated}   without a usable JE: ${jeMissing}`);
}

run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
