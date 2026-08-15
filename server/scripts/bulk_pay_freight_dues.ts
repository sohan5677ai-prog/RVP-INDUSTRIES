/**
 * One-off: mark every currently-unpaid outward / inward / KNM-usual lorry
 * freight as paid, each dated to its own transport-event date (dispatch date
 * for outward, stock-in arrival date for inward) rather than today. Transfer
 * freight (husk/seed/dust, billed to KNM Transport) is deliberately excluded.
 *
 * This mirrors the exact row-building + combineSharedLorryRows + per-lorry
 * FIFO due logic in client/src/pages/FreightDues.tsx, so the amounts/paid
 * status this produces match what that page shows. It also repairs the 5
 * pre-existing payments that were recorded with type 'TRANSPORTER' (which the
 * ledger never routed to the Freight Payable account, and which the page
 * never recognised as paid) into 'TRANSPORTER_OUTWARD'.
 *
 * Idempotent: due is recomputed from live Payment rows each run, so a partial
 * run can simply be re-executed.
 *
 * Usage:
 *   npx tsx scripts/bulk_pay_freight_dues.ts            # dry run (default)
 *   npx tsx scripts/bulk_pay_freight_dues.ts --execute   # actually write
 */
import { prisma } from '../src/lib/prisma.js';
import { LedgerService } from '../src/services/ledger.service.js';
import { calcHamali, calcKataFee, companyVehicleNumbers, pappuLoadingHamali, qualityAdjustmentFreight } from '../src/lib/calc.js';

const EXECUTE = process.argv.includes('--execute');

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

type Sourced = 'Purchase' | 'Sale' | 'Transfer';

interface FreightRow {
  id: string;
  date: Date;
  lorry: string | null;
  net: number;
  sourced: Sourced;
  label: string; // for logging
}

function combineSharedLorryRows(rows: FreightRow[]): FreightRow[] {
  const groups = new Map<string, FreightRow[]>();
  for (const r of rows) {
    if (!r.lorry) {
      groups.set(`nolorry-${r.id}`, [r]);
      continue;
    }
    const dateKey = r.date.toISOString().slice(0, 10);
    const key = `${r.lorry.toUpperCase()}_${dateKey}`;
    const list = groups.get(key) || [];
    list.push(r);
    groups.set(key, list);
  }
  const result: FreightRow[] = [];
  for (const list of groups.values()) {
    if (list.length === 1) {
      result.push(list[0]);
      continue;
    }
    const sourcedSet = new Set(list.map((x) => x.sourced));
    const sourced = (sourcedSet.size === 1 ? list[0].sourced : 'Purchase / Sale') as Sourced;
    const totalNet = round2(list.reduce((s, x) => s + x.net, 0));
    result.push({
      id: `comb-${list[0].lorry}-${list[0].date.toISOString().slice(0, 10)}`,
      date: list[0].date,
      lorry: list[0].lorry,
      net: totalNet,
      sourced,
      label: list.map((x) => x.label).join(' + '),
    });
  }
  return result;
}

async function main() {
  console.log(EXECUTE ? '*** EXECUTE MODE - will write real Payment + JournalEntry rows ***' : 'DRY RUN (pass --execute to write)');

  // --- Step 1: repair the 5 pre-existing mis-typed lorry payments ----------
  const brokenPayments = await prisma.payment.findMany({ where: { type: 'TRANSPORTER' } });
  console.log(`\nFound ${brokenPayments.length} payment(s) with legacy type 'TRANSPORTER' to repair to 'TRANSPORTER_OUTWARD'.`);
  for (const p of brokenPayments) {
    console.log(`  Payment ${p.id}: ${p.date.toISOString().slice(0, 10)} lorry=${p.lorryNumber} amount=${p.amount}`);
    if (!EXECUTE) continue;
    await prisma.$transaction(async (tx) => {
      if (p.journalEntryId) {
        await tx.payment.update({ where: { id: p.id }, data: { journalEntryId: null } });
        await tx.journalEntry.delete({ where: { id: p.journalEntryId } });
      }
      await tx.payment.update({ where: { id: p.id }, data: { type: 'TRANSPORTER_OUTWARD' } });
      await LedgerService.postPayment(tx, p.id, {
        date: p.date,
        amount: Number(p.amount),
        type: 'TRANSPORTER_OUTWARD',
        lorryNumber: p.lorryNumber ?? undefined,
        reference: p.reference ?? undefined,
        description: p.description ?? undefined,
      });
      const je = await tx.journalEntry.findFirst({ where: { reference: `PAYMENT-${p.id}` } });
      await tx.payment.update({ where: { id: p.id }, data: { journalEntryId: je?.id ?? null } });
    });
  }

  // --- Step 2: build freight rows exactly like FreightDues.tsx -------------
  const company = await prisma.companyProfile.findFirst();
  const knmList = companyVehicleNumbers((company as any)?.companyVehicles);
  const retention = Number((company as any)?.freightRetentionPerTrip ?? 3000);

  const purchases = await prisma.purchase.findMany({ include: { stockIn: true, verification: true } });
  const saleOrders = await prisma.saleOrder.findMany({ include: { dispatches: true } });

  function inwardFreightOf(p: any): number {
    const rawFreight = Number(p.freightCharge ?? 0);
    const basis = Number(p.freightTonnageKg ?? p.stockIn?.freightTonnageKg ?? 0);
    const net = Number(p.netWeightKg ?? 0);
    const baseFreight = basis > 0 && net > 0 ? (rawFreight * net) / basis : rawFreight;
    return baseFreight + qualityAdjustmentFreight((p.verification as any)?.qualityAdjustments);
  }

  const allOutward: FreightRow[] = saleOrders
    .flatMap((o) => o.dispatches.map((d) => ({ o, d })))
    .filter(({ d }) => Number(d.freightCharge) > 0)
    .map(({ o, d }) => {
      const freight = Number(d.freightCharge);
      const provider = (d as any).transportProvider ?? (d.vehicleNumber && knmList.includes(d.vehicleNumber.trim().toLowerCase()) ? 'KNM' : 'SURYA');
      const isKnm = provider === 'KNM';
      const hamali = isKnm ? 0 : (o.product === 'PAPPU' ? pappuLoadingHamali(d.weightKg).lorry : calcHamali(d.weightKg));
      const kata = isKnm ? 0 : calcKataFee(d.weightKg);
      const transport = provider === 'SURYA' ? retention : (provider === 'OTHER' ? Number((d as any).customRetention ?? 0) : 0);
      return {
        id: d.id,
        date: d.dispatchDate,
        lorry: d.vehicleNumber?.trim().toUpperCase() ?? null,
        net: round2(freight - hamali - kata - transport),
        sourced: 'Sale' as const,
        label: `Sale dispatch ${d.id.slice(0, 8)} (${d.dispatchDate.toISOString().slice(0, 10)})`,
      };
    });

  const allInward: FreightRow[] = purchases
    .filter((p) => inwardFreightOf(p) > 0)
    .map((p) => {
      const freight = round2(inwardFreightOf(p));
      const lorry = p.stockIn?.lorryNumber ?? null;
      const isKnm = lorry ? knmList.includes(lorry.trim().toLowerCase()) : false;
      const hamali = isKnm ? 0 : Number(p.hamaliCharge ?? 0);
      const kata = isKnm ? 0 : Number(p.kataFee ?? 0);
      return {
        id: p.id,
        date: p.stockIn?.arrivalDate ?? p.createdAt,
        lorry: lorry?.trim().toUpperCase() ?? null,
        net: round2(freight - hamali - kata),
        sourced: 'Purchase' as const,
        label: `Purchase ${p.id.slice(0, 8)} (${(p.stockIn?.arrivalDate ?? p.createdAt).toISOString().slice(0, 10)})`,
      };
    });

  const knmRowsRaw = [
    ...allOutward.filter((r) => r.lorry && knmList.includes(r.lorry.toLowerCase())),
    ...allInward.filter((r) => r.lorry && knmList.includes(r.lorry.toLowerCase())),
  ];
  const outwardRowsRaw = allOutward.filter((r) => !r.lorry || !knmList.includes(r.lorry.toLowerCase()));
  const inwardRowsRaw = allInward.filter((r) => !r.lorry || !knmList.includes(r.lorry.toLowerCase()));

  const knmRows = combineSharedLorryRows(knmRowsRaw);
  const outwardRows = combineSharedLorryRows(outwardRowsRaw);
  const inwardRows = combineSharedLorryRows(inwardRowsRaw);

  // Transfer rows: included in the FIFO pool (so non-transfer dues match the
  // UI exactly) but never paid.
  const huskTransfers = await prisma.huskTransfer.findMany();
  const stockTransfers = await prisma.stockTransfer.findMany();
  const shellTransfers = await prisma.shellTransfer.findMany();
  const transferRows: FreightRow[] = [
    ...huskTransfers.map((t) => ({ id: `husk-${t.id}`, date: t.transferDate, lorry: t.lorryNumber?.trim().toUpperCase() ?? null, net: round2(Number(t.transportCharge)), sourced: 'Transfer' as const, label: `Husk transfer ${t.id.slice(0, 8)}` })),
    ...stockTransfers.map((t) => ({ id: `seed-${t.id}`, date: t.transferDate, lorry: t.lorryNumber?.trim().toUpperCase() ?? null, net: round2(Number(t.transportCharge)), sourced: 'Transfer' as const, label: `Seed transfer ${t.id.slice(0, 8)}` })),
    ...shellTransfers.map((t) => ({ id: `dust-${t.id}`, date: t.transferDate, lorry: t.lorryNumber?.trim().toUpperCase() ?? null, net: round2(Number(t.transportCharge)), sourced: 'Transfer' as const, label: `Dust transfer ${t.id.slice(0, 8)}` })),
  ].filter((r) => r.net > 0);

  // --- Step 3: per-lorry FIFO due, using freshly repaired payments ---------
  // Transfer rows are deliberately excluded from this pool (matching the fix
  // in client/src/pages/FreightDues.tsx): a lorry that also runs husk/seed/
  // dust transfers must never have those legs silently marked paid by freight
  // payments (or vice versa) just because they share a lorry number.
  const payments = await prisma.payment.findMany({ where: { lorryNumber: { not: null } } });
  const paidByLorry = new Map<string, number>();
  for (const p of payments) {
    if (p.type === 'TRANSPORTER' || p.type === 'TRANSPORTER_INWARD' || p.type === 'TRANSPORTER_OUTWARD') {
      const k = p.lorryNumber!.trim().toUpperCase();
      paidByLorry.set(k, (paidByLorry.get(k) ?? 0) + Number(p.amount));
    }
  }

  console.log(`\n(${transferRows.length} transfer row(s) exist but are excluded from the freight pool and never paid by this script.)`);

  const allRows = [...inwardRows, ...outwardRows, ...knmRows];
  const rowsByLorry = new Map<string, FreightRow[]>();
  for (const r of allRows) {
    if (!r.lorry) continue;
    const list = rowsByLorry.get(r.lorry) || [];
    list.push(r);
    rowsByLorry.set(r.lorry, list);
  }

  const toPay: { row: FreightRow; due: number }[] = [];
  for (const [lorry, rows] of rowsByLorry.entries()) {
    rows.sort((a, b) => a.date.getTime() - b.date.getTime());
    let remaining = paidByLorry.get(lorry) ?? 0;
    for (const r of rows) {
      let due: number;
      if (remaining <= 0) {
        due = r.net;
      } else if (remaining + 0.01 >= r.net) {
        remaining -= r.net;
        due = 0;
      } else {
        due = round2(r.net - remaining);
        remaining = 0;
      }
      if (due > 0.01 && r.sourced !== 'Transfer') {
        toPay.push({ row: r, due });
      }
    }
  }

  toPay.sort((a, b) => a.row.date.getTime() - b.row.date.getTime());

  console.log(`\n${toPay.length} row(s) to pay, total due Rs ${round2(toPay.reduce((s, x) => s + x.due, 0))}`);
  for (const { row, due } of toPay) {
    console.log(`  ${row.date.toISOString().slice(0, 10)}  ${row.lorry}  ${row.sourced.padEnd(14)}  Rs ${due}   ${row.label}`);
  }

  if (!EXECUTE) {
    console.log('\nDry run only - no payments created. Re-run with --execute to write these.');
    return;
  }

  console.log('\nCreating payments...');
  let created = 0;
  for (const { row, due } of toPay) {
    const type = row.sourced === 'Purchase' ? 'TRANSPORTER_INWARD' : 'TRANSPORTER_OUTWARD';
    const amount = Math.round(due); // whole-rupee, matching wholeRupee schema transform
    if (amount <= 0) continue;
    await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          date: row.date,
          amount,
          type,
          lorryNumber: row.lorry,
          description: `Freight payment - Lorry ${row.lorry}`,
        },
      });
      await LedgerService.postPayment(tx, payment.id, {
        date: row.date,
        amount,
        type,
        lorryNumber: row.lorry ?? undefined,
        description: `Freight payment - Lorry ${row.lorry}`,
      });
      const je = await tx.journalEntry.findFirst({ where: { reference: `PAYMENT-${payment.id}` } });
      if (je) await tx.payment.update({ where: { id: payment.id }, data: { journalEntryId: je.id } });
    });
    created++;
  }
  console.log(`Done. Created ${created} payment(s).`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
