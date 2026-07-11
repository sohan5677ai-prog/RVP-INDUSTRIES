import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const partyNames = [
    "Spectrum",
    "Colourtex",
    "Soham Agro",
    "Enegix - Soham Agro",
    "Enegix",
    "Vimal Industries",
    "Srinivasa Agro",
    "Adinath",
    "Chhaya Industries"
  ];

  const parties = await prisma.party.findMany({
    where: {
      name: {
        in: partyNames
      }
    }
  });

  for (const party of parties) {
    if (!party.commodities.includes('PAPPU')) {
      await prisma.party.update({
        where: { id: party.id },
        data: {
          commodities: {
            push: 'PAPPU'
          }
        }
      });
      console.log(`Updated ${party.name} to include PAPPU`);
    } else {
      console.log(`${party.name} already has PAPPU`);
    }
  }

  console.log("Done!");
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
