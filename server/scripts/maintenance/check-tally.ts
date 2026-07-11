import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkSyncStatus() {
  console.log("=== Tally Sync Status ===");
  const state = await prisma.tallySyncState.findFirst();
  console.log(state ? `Last Sync At: ${state.lastSyncAt}, Last Alter ID: ${state.lastAlterId}` : "No sync state found.");

  console.log("\n=== Unmapped Vouchers (Pending) ===");
  const unmapped = await prisma.tallyUnmappedVoucher.findMany({
    orderBy: { date: 'desc' },
    take: 5
  });
  if (unmapped.length === 0) {
    console.log("No unmapped vouchers pending.");
  } else {
    unmapped.forEach(v => console.log(`- ${v.date.toISOString().split('T')[0]} | ${v.voucherType} | ${v.ledgerName} | ${v.amount}`));
  }

  console.log("\n=== Recently Synced Payments ===");
  const payments = await prisma.payment.findMany({
    where: { source: 'tally' },
    orderBy: { createdAt: 'desc' },
    take: 5
  });
  if (payments.length === 0) {
    console.log("No payments synced from Tally.");
  } else {
    payments.forEach(p => console.log(`- ${p.date.toISOString().split('T')[0]} | PartyId: ${p.partyId} | Amount: ${p.amount}`));
  }
  
  console.log("\n=== Recently Synced Receipts ===");
  const receipts = await prisma.receipt.findMany({
    where: { source: 'tally' },
    orderBy: { createdAt: 'desc' },
    take: 5
  });
  if (receipts.length === 0) {
    console.log("No receipts synced from Tally.");
  } else {
    receipts.forEach(r => console.log(`- ${r.date.toISOString().split('T')[0]} | PartyId: ${r.partyId} | Amount: ${r.amount}`));
  }

  await prisma.$disconnect();
}

checkSyncStatus().catch(console.error);
