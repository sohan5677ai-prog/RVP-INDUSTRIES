import { prisma } from '../src/lib/prisma.js';

async function main() {
  const party = await prisma.party.findFirst({
    where: { name: { contains: 'SBT', mode: 'insensitive' } }
  });
  console.log('SBT Party:', party?.name, 'State:', party?.state, 'Address:', party?.address);
}

main().catch(console.error);
