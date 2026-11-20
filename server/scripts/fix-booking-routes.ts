// One-off backfill: put the factory on one end of every booked lorry's route.
//
// The reply form asks a transporter for a single place, and it was filed as
// `fromPlace` while the sale order's destination went in as `toPlace`. On an
// outbound trip those are the same town, so the register read
// "AHMEDNAGAR -> Ahilyanagar" - one delivery written as a route between a town
// and itself. See src/lib/bookingRoute.ts for the rule applied here.
//
// Dry run by default; pass --apply to write.
import { prisma } from '../src/lib/prisma.js';
import { bookingRoute, DEFAULT_HOME_PLACE } from '../src/lib/bookingRoute.js';
import { writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');

async function main() {
  const company = await prisma.companyProfile.findFirst({ select: { dispatchFromPlace: true } });
  const home = company?.dispatchFromPlace?.trim() || DEFAULT_HOME_PLACE;

  const rows = await prisma.transportConfirmation.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      direction: true,
      fromPlace: true,
      toPlace: true,
      lorryNumber: true,
      dispatchSlotId: true,
    },
  });

  // The slot carries the order, and the order carries the town the lorry is
  // actually going to - which outranks whatever the transporter typed.
  const slotIds = rows.map((r) => r.dispatchSlotId).filter((id): id is string => !!id);
  const slots = slotIds.length
    ? await prisma.dispatchSlot.findMany({
        where: { id: { in: slotIds } },
        select: {
          id: true,
          saleOrder: { select: { destination: true, buyer: { select: { city: true } } } },
        },
      })
    : [];
  const destinationBySlot = new Map(
    slots.map((s) => [s.id, s.saleOrder?.destination || s.saleOrder?.buyer?.city || null]),
  );

  const changes: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const route = bookingRoute({
      direction: row.direction,
      fromPlace: row.fromPlace,
      toPlace: row.toPlace,
      destination: row.dispatchSlotId ? destinationBySlot.get(row.dispatchSlotId) ?? null : null,
      home,
    });
    if (route.fromPlace === row.fromPlace && route.toPlace === row.toPlace) continue;
    changes.push({
      id: row.id,
      lorryNumber: row.lorryNumber,
      direction: row.direction,
      before: { fromPlace: row.fromPlace, toPlace: row.toPlace },
      after: route,
    });
  }

  if (changes.length === 0) {
    console.log(`Nothing to do - all ${rows.length} bookings already route through ${home}.`);
    return;
  }

  for (const c of changes) {
    const b = c.before as { fromPlace: string | null; toPlace: string | null };
    const a = c.after as { fromPlace: string | null; toPlace: string | null };
    console.log(
      `${c.lorryNumber ?? '(no lorry no)'} [${c.direction}]  ${b.fromPlace ?? '?'} -> ${b.toPlace ?? '?'}   =>   ${a.fromPlace ?? '?'} -> ${a.toPlace ?? '?'}`,
    );
  }
  console.log(`\n${changes.length} of ${rows.length} bookings would change.`);

  if (!APPLY) {
    console.log('Dry run - pass --apply to write.');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `scripts/backup_booking_routes_${stamp}.json`;
  writeFileSync(backup, JSON.stringify(changes, null, 2));
  console.log(`Backup written to ${backup}`);

  for (const c of changes) {
    const a = c.after as { fromPlace: string | null; toPlace: string | null };
    await prisma.transportConfirmation.update({
      where: { id: c.id as string },
      data: { fromPlace: a.fromPlace, toPlace: a.toPlace },
    });
  }
  console.log(`Updated ${changes.length} bookings.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
