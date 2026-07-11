/**
 * One-off: recompute loading-hamali on EXISTING Pappu sale dispatches so they
 * carry the current Hamali Rates - including any custom costs added in Settings -
 * and rewrite their ledger postings to match.
 *
 * Only the four hamali-affected journal lines are touched per sale, keeping the
 * identity company + lorry = crew + margin (so the entry stays balanced):
 *   20250 Lorry Owner Payable   credit = freight − lorryShare − kata − retention
 *   50070 Loading Hamali Expense debit = company share (= total − lorryShare)
 *   20200 Hamali crew payable    credit = crew (= total − margin)
 *   40030 Hamali Income          credit = company P/L margin
 * Revenue, GST, COGS, freight, kata and retention lines are left untouched.
 *
 * Usage (run from server/):
 *   npx tsx src/scripts/recomputeSaleHamali.ts          # dry-run, prints the diff
 *   npx tsx src/scripts/recomputeSaleHamali.ts --apply  # write the changes
 *
 * Take a database backup before running with --apply: it rewrites historical
 * ledger entries.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { pappuLoadingHamali, customLoadingHamali } from '../lib/calc.js';
import { getHamaliRateFull, getCustomHamaliRates } from '../controllers/settings.controller.js';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const r2 = (n: number) => Math.round(n * 100) / 100;

type Target = { code: string; debit?: number; credit?: number; costCenter?: string };

/** Set one line (by account code) to the target amount; create if missing, delete if zero. */
async function setLine(
  tx: Prisma.TransactionClient,
  entryId: string,
  lines: { id: string; accountId: string; account: { code: string } }[],
  idByCode: Map<string, string>,
  t: Target
) {
  const existing = lines.find((l) => l.account.code === t.code);
  const debit = r2(t.debit ?? 0);
  const credit = r2(t.credit ?? 0);
  if (debit === 0 && credit === 0) {
    if (existing) await tx.journalLine.delete({ where: { id: existing.id } });
    return;
  }
  if (existing) {
    await tx.journalLine.update({ where: { id: existing.id }, data: { debit, credit, costCenter: t.costCenter ?? null } });
  } else {
    const accountId = idByCode.get(t.code);
    if (!accountId) throw new Error(`Chart of Account not found for code ${t.code}`);
    await tx.journalLine.create({
      data: { journalEntryId: entryId, accountId, debit, credit, costCenter: t.costCenter ?? null },
    });
  }
}

async function main() {
  const pl = await getHamaliRateFull('PAPPU_LOADING');
  const custom = await getCustomHamaliRates();
  console.log(`Pappu Loading: total ₹${pl.total}/t, lorry ₹${pl.lorry}/t, margin ₹${pl.margin}/t`);
  console.log(`Custom costs charged on Pappu dispatch: ${custom.length ? custom.map((c) => `${c.label} (₹${c.total}/t)`).join(', ') : 'none'}`);
  console.log(APPLY ? '\n=== APPLY MODE - writing changes ===\n' : '\n=== DRY RUN - no changes written (pass --apply to write) ===\n');

  const accounts = await prisma.account.findMany({ select: { id: true, code: true } });
  const idByCode = new Map(accounts.map((a) => [a.code, a.id]));

  const dispatches = await prisma.saleDispatch.findMany({
    where: { saleOrder: { product: 'PAPPU' } },
    include: { saleOrder: true },
    orderBy: { createdAt: 'asc' },
  });

  let updated = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const d of dispatches) {
    const entry = await prisma.journalEntry.findFirst({
      where: { reference: `SALE-${d.id}` },
      include: { lines: { include: { account: true } } },
    });
    if (!entry) { skipped++; continue; }

    const freightLine = entry.lines.find((l) => l.account.code === '50050');
    const F = freightLine ? Number(freightLine.debit) : 0;
    if (F <= 0) { skipped++; continue; } // ex-works / no freight to split - out of scope

    const kata = entry.lines.filter((l) => l.account.code === '20270').reduce((s, l) => s + Number(l.credit), 0);
    const retention = entry.lines.filter((l) => l.account.code === '20255').reduce((s, l) => s + Number(l.credit), 0);

    // New split: standard Pappu loading + every custom cost, same model.
    const lh = pappuLoadingHamali(d.weightKg, false, pl.total, pl.lorry, pl.margin);
    let lorry = lh.lorry, crew = lh.crew, company = lh.company, margin = lh.margin;
    for (const c of custom) {
      const ch = customLoadingHamali(d.weightKg, c.total, c.lorry, c.margin);
      lorry += ch.lorry; crew += ch.crew; company += ch.company; margin += ch.margin;
    }
    const lorryOwner = r2(F - lorry - kata - retention);

    // Current posted values, for the diff and the no-op check.
    const cur = (code: string, side: 'debit' | 'credit') =>
      entry.lines.filter((l) => l.account.code === code).reduce((s, l) => s + Number(l[side]), 0);
    const before = { lorryOwner: cur('20250', 'credit'), company: cur('50070', 'debit'), crew: cur('20200', 'credit'), margin: cur('40030', 'credit') };
    const changed =
      r2(before.lorryOwner) !== lorryOwner || r2(before.company) !== r2(company) || r2(before.crew) !== r2(crew) || r2(before.margin) !== r2(margin);

    if (!changed) { unchanged++; continue; }

    console.log(
      `SALE-${d.id} (${d.weightKg}kg, freight ₹${F}):\n` +
      `   crew     ${before.crew.toFixed(2)} → ${crew.toFixed(2)}\n` +
      `   company  ${before.company.toFixed(2)} → ${company.toFixed(2)}\n` +
      `   margin   ${before.margin.toFixed(2)} → ${margin.toFixed(2)}\n` +
      `   lorryOwn ${before.lorryOwner.toFixed(2)} → ${lorryOwner.toFixed(2)}`
    );

    if (APPLY) {
      await prisma.$transaction(async (tx) => {
        await setLine(tx, entry.id, entry.lines, idByCode, { code: '20250', credit: lorryOwner });
        await setLine(tx, entry.id, entry.lines, idByCode, { code: '50070', debit: company, costCenter: d.saleOrder.product });
        await setLine(tx, entry.id, entry.lines, idByCode, { code: '20200', credit: crew, costCenter: 'Hamali Team' });
        await setLine(tx, entry.id, entry.lines, idByCode, { code: '40030', credit: margin, costCenter: d.saleOrder.product });

        // Safety net: the entry must still balance, else abort this sale.
        const after = await tx.journalLine.findMany({ where: { journalEntryId: entry.id } });
        const dr = after.reduce((s, l) => s + Number(l.debit), 0);
        const crd = after.reduce((s, l) => s + Number(l.credit), 0);
        if (r2(dr) !== r2(crd)) throw new Error(`SALE-${d.id} would not balance (Dr ${r2(dr)} ≠ Cr ${r2(crd)}) - aborted`);
      });
    }
    updated++;
  }

  console.log(`\n${APPLY ? 'Updated' : 'Would update'}: ${updated}   Unchanged: ${unchanged}   Skipped (no entry / no freight): ${skipped}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
