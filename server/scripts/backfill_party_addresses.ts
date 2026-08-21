import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';

async function main() {
  const parties = await prisma.party.findMany({
    where: { address: { not: null } },
    include: { addresses: true },
  });
  console.log(`Found ${parties.length} parties with address`);
  const toInsert = parties
    .filter((p) => p.addresses.length === 0 && p.address && p.address.trim() !== '')
    .map((p) => ({
      partyId: p.id,
      label: 'Registered Office',
      address: p.address!,
      city: p.city ?? null,
      state: p.state ?? null,
      pincode: p.pincode ?? null,
      gstin: p.gstin ?? null,
      isDefault: true,
    }));

  if (toInsert.length > 0) {
    const res = await prisma.partyAddress.createMany({ data: toInsert });
    console.log(`Backfilled ${res.count} party addresses in batch.`);
  } else {
    console.log('All parties already have addresses.');
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());

