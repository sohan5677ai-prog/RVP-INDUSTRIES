/**
 * Clear the phantom lorry bookings out of the register.
 *
 * Before the webhook fix, every photo, voice note and PDF sent to the shared
 * WhatsApp number was handed to Gemini as if the media's own URL were the
 * message text. With nothing readable in it, the model answered with the worked
 * example from its own prompt, so each picture filed another booking for
 * "18 Jul 2026 / AP39T8217 / Driver Moula / Rs 80,000" - a lorry nobody booked.
 *
 * Those rows are recognisable: rawText is nothing but a link. None of them can
 * be attached to a dispatch (the script refuses any that are), so deleting them
 * takes nothing real with it.
 *
 *   npx tsx scripts/purge-phantom-lorry-bookings.ts          # list only
 *   npx tsx scripts/purge-phantom-lorry-bookings.ts --apply  # delete
 */
import { prisma } from '../src/lib/prisma.js';

const apply = process.argv.includes('--apply');

async function main() {
  const rows = await prisma.transportConfirmation.findMany({
    select: { id: true, rawText: true, status: true, saleDispatchId: true, lorryNumber: true, messageDate: true },
  });

  const phantom = rows.filter((r) => /^https?:\/\/\S*$/i.test((r.rawText || '').trim()));
  const linked = phantom.filter((r) => r.saleDispatchId);

  console.log(`${rows.length} bookings in the register, ${phantom.length} of them read out of a bare link.`);
  for (const r of phantom) {
    console.log(`  ${r.status.padEnd(9)} ${r.lorryNumber ?? '(no lorry)'}  ${r.messageDate?.toISOString().slice(0, 10) ?? '(no date)'}  ${r.rawText}`);
  }

  if (linked.length) {
    console.error(`\nRefusing to delete: ${linked.length} of these are attached to a dispatch. Check them by hand.`);
    process.exitCode = 1;
    return;
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to delete these rows.');
    return;
  }

  const { count } = await prisma.transportConfirmation.deleteMany({
    where: { id: { in: phantom.map((r) => r.id) } },
  });
  console.log(`\nDeleted ${count} phantom bookings.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
