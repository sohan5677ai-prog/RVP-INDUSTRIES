import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const partyNames = [
    "Seenappa Chintamani",
    "Ramesh Chennai",
    "Spectrum",
    "Colourtex",
    "Soham Agro",
    "Enegix - Soham Agro",
    "Enegix",
    "Vimal Industries",
    "Srinivasa Agro",
    "Adinath",
    "Chhaya Industries",
    "Marthandam",
    "Yallammadevi Enterprises",
    "Velichamy",
    "Senthil Papparpatty",
    "Nandeesh Chintamani",
    "Karthikeyan Pallipattu",
    "Suresh Katpadi",
    "Baba MTC",
    "Murugan and Co",
    "CRS",
    "Bismillah Traders",
    "AB Traders",
    "Mithun Agencies",
    "Mahesh Trading",
    "MMS",
    "Anandham Kovilpatti",
    "KNT",
    "Babavali Kutagula",
    "Sultan",
    "Kamaraj Marthandam",
    "Baburao",
    "Bismillah Enterprises",
    "Sadiq Anchetty",
    "Pragati Traders",
    "Kata Senthil",
    "Kalyandurgam Maruti",
    "Murali Marnalli",
    "Sri Vinayaga Traders - Dinakaran",
    "Siddhi Vinayaka Traders",
    "Vijay Katpadi",
    "Johar",
    "Karthik Traders",
    "Malola Narasimha Traders",
    "Arul Dindivanam",
    "KMK Traders",
    "NPK Traders",
    "HMS Traders",
    "Raghu Sira (NPK Traders)",
    "Vijayalakshmi Trading Co",
    "KTV Karimangalam",
    "Fayaz V Kota",
    "Sri Rajalakshmi Stores",
    "DCS",
    "Kannan Katpadi",
    "Siddiq V Kota",
    "Kallur Kadervalli"
  ];

  const parties = await prisma.party.findMany({
    where: {
      name: {
        in: partyNames
      }
    }
  });

  for (const party of parties) {
    if (!party.commodities.includes('BLACK_SEED')) {
      await prisma.party.update({
        where: { id: party.id },
        data: {
          commodities: {
            push: 'BLACK_SEED'
          }
        }
      });
      console.log(`Updated ${party.name} to include BLACK_SEED`);
    } else {
      console.log(`${party.name} already has BLACK_SEED`);
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
