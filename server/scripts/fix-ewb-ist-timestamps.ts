// One-off repair: before commit cc39033 (1 Aug 2026), TaxproService stored NIC
// timestamps with `new Date(data.EwbDt)`. NIC returns IST *without* an offset
// ("2026-08-01 09:59:00"), so a UTC server parsed it as UTC and the instant
// landed 5:30 too late. `parseNicDate` fixed new records; this realigns the old
// ones.
//
// Fingerprint: NIC always expires an e-way bill at 23:59 IST on the last valid
// day. A correctly-stored row therefore reads 23:59 in IST; a double-shifted
// row reads 05:29 IST the following morning. Rows matching neither are left
// alone and reported, so nothing is guessed at.
//
// Dry-run by default. Pass --apply to write (a JSON backup is saved first).
import { prisma } from '../src/lib/prisma.js';
import { IST_TZ } from '../src/lib/istDate.js';
import { writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const SHIFT_MS = 5.5 * 60 * 60 * 1000;

const ist = (d: Date | null) =>
  d ? d.toLocaleString('en-GB', { timeZone: IST_TZ, dateStyle: 'medium', timeStyle: 'short' }) : '—';

/** "HH:MM" of an instant in IST. */
const istHhMm = (d: Date) => {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${get('hour')}:${get('minute')}`;
};

async function main() {
  const rows = await prisma.saleDispatch.findMany({
    where: { ewbNumber: { not: null }, ewbDate: { not: null }, ewbValidUpto: { not: null } },
    select: {
      id: true, ewbNumber: true, invoiceNumber: true, ewbStatus: true,
      ewbDate: true, ewbValidUpto: true, irnAckDate: true,
    },
    orderBy: { ewbDate: 'asc' },
  });

  console.log(`${rows.length} dispatch row(s) carry an e-way bill.\n`);

  const shifted: typeof rows = [];
  const okRows: typeof rows = [];
  const unclear: typeof rows = [];

  for (const r of rows) {
    const hhmm = istHhMm(r.ewbValidUpto!);
    if (hhmm === '23:59') okRows.push(r);
    else if (hhmm === '05:29') shifted.push(r);
    else unclear.push(r);
  }

  const line = (r: (typeof rows)[number], note = '') =>
    `  ${String(r.ewbNumber).padEnd(14)} ${String(r.invoiceNumber ?? '—').padEnd(18)}` +
    ` gen ${ist(r.ewbDate).padEnd(22)} valid ${ist(r.ewbValidUpto).padEnd(22)} ${note}`;

  console.log(`=== ALREADY CORRECT (valid-upto 23:59 IST): ${okRows.length} ===`);
  okRows.forEach((r) => console.log(line(r)));

  console.log(`\n=== SHIFTED +5:30, NEEDS REPAIR: ${shifted.length} ===`);
  shifted.forEach((r) =>
    console.log(line(r, `-> gen ${ist(new Date(r.ewbDate!.getTime() - SHIFT_MS))}`)),
  );

  console.log(`\n=== UNCLEAR, LEFT ALONE: ${unclear.length} ===`);
  unclear.forEach((r) => console.log(line(r, `valid-upto reads ${istHhMm(r.ewbValidUpto!)} IST`)));

  if (shifted.length === 0) {
    console.log('\nNothing to repair.');
    return;
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. Re-run with --apply to repair ${shifted.length} row(s).`);
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `scripts/backup_ewb_ist_timestamps_${stamp}.json`;
  writeFileSync(
    backupPath,
    JSON.stringify(
      shifted.map((r) => ({
        id: r.id, ewbNumber: r.ewbNumber, invoiceNumber: r.invoiceNumber,
        ewbDate: r.ewbDate, ewbValidUpto: r.ewbValidUpto, irnAckDate: r.irnAckDate,
      })),
      null, 2,
    ),
  );
  console.log(`\nBackup written: ${backupPath}`);

  for (const r of shifted) {
    await prisma.saleDispatch.update({
      where: { id: r.id },
      data: {
        ewbDate: new Date(r.ewbDate!.getTime() - SHIFT_MS),
        ewbValidUpto: new Date(r.ewbValidUpto!.getTime() - SHIFT_MS),
        // irnAckDate came through the same un-offsetted `new Date(data.AckDt)`
        // path, so it carries the identical shift when present.
        ...(r.irnAckDate ? { irnAckDate: new Date(r.irnAckDate.getTime() - SHIFT_MS) } : {}),
      },
    });
  }
  console.log(`Repaired ${shifted.length} row(s).`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
