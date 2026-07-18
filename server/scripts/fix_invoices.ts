import { prisma } from '../src/lib/prisma.js';
import { writeFileSync } from 'node:fs';

// ---- Authoritative list: seq -> lorry (for sanity-checking the parse) ----
const CANON_LORRY: Record<number, string> = {
  1: 'TN28BF7423', 2: 'TN524070', 3: 'TN28BF7498', 4: 'TN30AM0299', 5: 'TN28BM9403',
  6: 'TN524070', 7: 'KA56-8383', 8: 'TN28BF7423', 9: 'TN52Q2882', 10: 'AP04TU0561',
  11: 'TN524070', 12: 'TN52F6431', 13: 'TN28BF7423', 14: 'TN28BF7498', 15: 'TN29DX2661',
  16: 'TN52AB3633', 17: 'TN52M7456', 18: 'TN52H8879', 19: 'TN52AD8526', 20: 'AP03TE9651',
  21: 'TN29BZ4108', 22: 'TN28BM9403', 23: 'TN52AF8868', 24: 'AP04TU0561', 25: 'TN34V7817',
  26: 'KA09D1455', 27: 'TN29BT4946', 28: 'TN90H8199', 29: 'TN52P5108', 30: 'AP02TC1023',
  31: 'TN52AF4353', 32: 'AP03TJ0150', 33: 'TN69BA4582', 34: 'TN83E2399', 35: 'TN52AE6064',
  36: 'TN28BF7498', 37: 'TN52M0483', 38: 'TN48AD7504', 39: 'TN28BF7423', 40: 'TN52AB1937',
  41: 'TN90H8199', 42: 'AP39U7475', 43: 'TN28BF7498', 44: 'AP03TE3029', 45: 'AP39WR0129',
  46: 'TN54P0019', 47: 'TN52Q1375', 48: 'TN52M4755', 49: 'AP03TE7209', 50: 'TN29CJ5779',
  51: 'TN29CC9492', 52: 'AP21TA1395', 53: 'TN36AK7378', 54: 'TN52J9102', 55: 'TN28BF7423',
  56: 'TN34AZ5349', 57: 'AP21TY9936', 58: 'TN86A6588', 59: 'TN25BF3740', 60: 'TN52P0705',
  61: 'TN52K5931', 62: 'AP39UF5999', 63: 'TN52F7055', 64: 'TN52H5492', 65: 'AP39UX9105',
  66: 'TN34W3799', 67: 'TN52D5808', 68: 'TN28BF7498', 69: 'TN28BF7423', 70: 'AP39UX9105',
  71: 'TN52AC2251', 72: 'TN88A6266', 73: 'TN52AH1074', 74: 'GJ06AX4056', 75: 'AP39WR0129',
  76: 'TN28BM9403', 77: 'AP04TT0099', 78: 'GJ03BV5571', 79: 'TN52M4755',
};

const FY = '2026-27';
const invStr = (seq: number) => `RVP/${String(seq).padStart(2, '0')}/26-27`;

// Explicit remaps for the two mis-sequenced Spectrum dispatches.
const REMAP: Record<string, number> = {
  cmr4omv8x0003s8l4zkh8c6z6: 78, // Spectrum GJ03BV5571 (was RVP/73/2026-27)
  cmr4xoh6q0003s8j0rg5supv6: 79, // Spectrum TN52M4755  (was RVP/01/2026-27)
};

// Byproduct dispatches (Babayya / Ali) that must be de-numbered — not in the list.
const CLEAR_IDS = new Set([
  'cmrgcy2lr0004s8xobkdj4qcr',
  'cmrgcy2os0008s8xoiis3phk8',
  'cmrgcy2p6000cs8xop3japncv',
  'cmriwzvb6003ps8jstinwnja9',
  'cmriwzvhr0042s8jstf5ewa8t',
  'cmriwzvm6004fs8jshaweuke1',
]);

const normLorry = (s: string | null) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const parseSeq = (inv: string | null) => {
  const m = inv?.match(/\/(\d+)\//);
  return m ? Number(m[1]) : null;
};

const APPLY = process.argv.includes('--apply');

type Plan = { id: string; label: string; seq: number | null; invoiceNumber: string | null };

async function main() {
  const dispatches = await prisma.saleDispatch.findMany({
    include: { saleOrder: { include: { buyer: true } } },
    orderBy: { createdAt: 'asc' },
  });

  // 1) Backup current invoice fields.
  const backup = dispatches.map((d) => ({
    id: d.id, invoiceNumber: d.invoiceNumber, invoiceSeq: d.invoiceSeq,
    invoiceFy: d.invoiceFy, invoiceDate: d.invoiceDate,
  }));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `scripts/backup_invoices_${stamp}.json`;
  writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`Backup written: ${backupPath}\n`);

  // 2) Guard: never clear/renumber a dispatch that has an active IRN or EWB.
  const guarded = dispatches.filter(
    (d) => (REMAP[d.id] || CLEAR_IDS.has(d.id)) && (d.irn || d.ewbNumber),
  );
  if (guarded.length) {
    console.error('ABORT: these to-be-changed dispatches have an IRN/EWB:', guarded.map((d) => d.id));
    return;
  }

  // 3) Build the plan.
  const plan: Plan[] = [];
  const seenSeq = new Map<number, string>();
  for (const d of dispatches) {
    let seq: number | null;
    if (CLEAR_IDS.has(d.id)) {
      seq = null;
    } else if (REMAP[d.id]) {
      seq = REMAP[d.id];
    } else {
      seq = parseSeq(d.invoiceNumber);
      if (seq == null) { console.error(`No parseable seq for ${d.id} (${d.invoiceNumber})`); return; }
      // sanity: the canonical lorry for this seq must match the dispatch's lorry
      if (normLorry(CANON_LORRY[seq]) !== normLorry(d.vehicleNumber)) {
        console.error(`Lorry mismatch for ${d.id}: seq ${seq} expects ${CANON_LORRY[seq]} but got ${d.vehicleNumber}`);
        return;
      }
    }
    if (seq != null) {
      if (seenSeq.has(seq)) { console.error(`Duplicate target seq ${seq}: ${seenSeq.get(seq)} & ${d.id}`); return; }
      seenSeq.set(seq, d.id);
    }
    plan.push({
      id: d.id,
      label: `${d.saleOrder?.buyer?.name} / ${d.vehicleNumber}`,
      seq,
      invoiceNumber: seq == null ? null : invStr(seq),
    });
  }

  // 4) Show only the rows that actually change.
  console.log('=== CHANGES ===');
  for (const p of plan) {
    const d = dispatches.find((x) => x.id === p.id)!;
    if (d.invoiceNumber !== p.invoiceNumber || d.invoiceSeq !== p.seq || d.invoiceFy !== (p.seq == null ? null : FY)) {
      console.log(`${d.invoiceNumber ?? '(none)'}  ->  ${p.invoiceNumber ?? '(cleared)'}   [${p.label}]`);
    }
  }
  console.log(`\nMax seq after fix: ${Math.max(...[...seenSeq.keys()])} (next raise -> RVP/${Math.max(...[...seenSeq.keys()]) + 1}/26-27)`);

  if (!APPLY) { console.log('\nDRY RUN. Re-run with --apply to write.'); return; }

  // 5) Apply. Phase A nulls seq/fy on every row (frees the unique space), phase B
  //    writes the final values. All inside one transaction.
  await prisma.$transaction(async (tx) => {
    await tx.saleDispatch.updateMany({ data: { invoiceSeq: null, invoiceFy: null } });
    for (const p of plan) {
      const d = dispatches.find((x) => x.id === p.id)!;
      if (p.seq == null) {
        await tx.saleDispatch.update({
          where: { id: p.id },
          data: { invoiceNumber: null, invoiceSeq: null, invoiceFy: null, invoiceDate: null },
        });
      } else {
        await tx.saleDispatch.update({
          where: { id: p.id },
          data: {
            invoiceNumber: p.invoiceNumber,
            invoiceSeq: p.seq,
            invoiceFy: FY,
            invoiceDate: d.invoiceDate ?? d.dispatchDate,
          },
        });
      }
    }
  });
  console.log('\nAPPLIED.');
}

main().finally(() => prisma.$disconnect());
