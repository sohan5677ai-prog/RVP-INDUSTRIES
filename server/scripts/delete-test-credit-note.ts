// One-off: remove RVP/CN/02/26-27 (Colourtex Industries), raised for testing
// purposes with a bogus 0 kg shortage. Deletes any EmailLog rows tied to it
// first (FK would otherwise block the delete), then the note itself.
//
//   node --import tsx scripts/delete-test-credit-note.ts          (dry run)
//   node --import tsx scripts/delete-test-credit-note.ts --apply
import { prisma } from '../src/lib/prisma.js';

const APPLY = process.argv.includes('--apply');
const NOTE_NUMBER = 'RVP/CN/02/26-27';

async function main() {
  const note = await prisma.creditNote.findUnique({
    where: { noteNumber: NOTE_NUMBER },
    include: { party: true, emailLogs: true },
  });

  if (!note) {
    console.log(`No credit note found with number ${NOTE_NUMBER}`);
    return;
  }

  console.log('Found credit note:');
  console.log({
    id: note.id,
    noteNumber: note.noteNumber,
    party: note.party.name,
    reason: note.reason,
    totalAmount: note.totalAmount.toString(),
    status: note.status,
    linkedEmailLogs: note.emailLogs.length,
  });

  if (!APPLY) {
    console.log('\nDry run - pass --apply to delete.');
    return;
  }

  await prisma.$transaction(async (tx) => {
    if (note.emailLogs.length > 0) {
      await tx.emailLog.deleteMany({ where: { creditNoteId: note.id } });
    }
    await tx.creditNote.delete({ where: { id: note.id } });
  });

  console.log('Deleted.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
