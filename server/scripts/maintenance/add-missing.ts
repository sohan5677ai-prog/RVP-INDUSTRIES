import { PrismaClient, SaleProduct } from '@prisma/client';

const prisma = new PrismaClient();

const jithuMissing = [
  { inv: '17', date: '2026-05-04', invDate: '2026-05-09', company: 'Enegix - Billed for Shahada', price: 51.00, due: '2026-05-13', tonnage: 30, lorry: 'TN22M7456', rvpKata: 29720 },
  { inv: '19', date: '2026-05-04', invDate: '2026-05-10', company: 'Enegix - Billed for Shahada', price: 51.00, due: '2026-05-14', tonnage: 35, lorry: 'TN52AD8526', rvpKata: 34670 },
  { inv: '35', date: '2026-05-11', invDate: '2026-05-20', company: 'Soham Agro - Enegix Ref', price: 52.00, due: '2026-05-24', tonnage: 35, lorry: 'TN52AE6064' },
  { inv: '40', date: '2026-05-25', invDate: '2026-05-27', company: 'Soham Agro', price: 50.50, due: '2026-06-14', tonnage: 30, lorry: 'TN52AB1937' },
  { inv: '68', date: '2026-06-25', invDate: '2026-06-25', company: 'Soham Agro', price: 49.00, due: '2026-06-28', tonnage: 25, lorry: 'TN28BF7498' },
  { inv: '69', date: '2026-06-25', invDate: '2026-06-25', company: 'Soham Agro', price: 49.00, due: '2026-06-28', tonnage: 25, lorry: 'TN28BF7423' },
  { inv: '71', date: '2026-06-25', invDate: '2026-06-27', company: 'Soham Agro', price: 49.00, due: '2026-06-30', tonnage: 25, lorry: 'TN52AC2251' },
  { inv: '73', date: '2026-06-25', invDate: '2026-06-29', company: 'Soham Agro', price: 49.00, due: '2026-07-02', tonnage: 25, lorry: 'TN52AH1074' }
];

const rvpMissing = [
  { inv: '57', date: '2026-05-02', invDate: '2026-06-08', company: 'Vinod Salem', price: 7.00, tonnage: 25, lorry: 'AP21TY9936' },
  { inv: '52', date: '2026-05-30', invDate: '2026-06-03', company: 'Balaji Challakere', price: 6.95, tonnage: 25, lorry: 'AP21TA1395' },
];

async function addRecords(arr: any[], brokerName: string) {
  const broker = await prisma.broker.findFirst({ where: { name: brokerName }});
  const brokerId = broker?.id;

  for (const item of arr) {
    let parties = await prisma.party.findMany();
    let party = parties.find(p => p.name.toLowerCase().includes(item.company.toLowerCase().split(' ')[0]));
    
    if (!party) {
      console.log('Creating missing party:', item.company);
      party = await prisma.party.create({
        data: {
          name: item.company,
          type: 'BUYER',
        }
      });
    }

    // Double check if already added by a previous run
    const existing = await prisma.saleOrder.findFirst({
      where: {
        buyerId: party.id,
        dispatches: { some: { vehicleNumber: item.lorry } }
      }
    });

    if (existing) {
      console.log('Already exists, skipping:', item.lorry);
      continue;
    }

    let dueDays = null;
    if (item.due && item.invDate) {
      dueDays = Math.round((new Date(item.due).getTime() - new Date(item.invDate).getTime()) / 86400000);
    }
    
    const product = item.price < 15 ? SaleProduct.HUSK : SaleProduct.PAPPU;

    const order = await prisma.saleOrder.create({
      data: {
        buyerId: party.id,
        brokerId: brokerId,
        saleDate: new Date(item.date),
        dueDays: dueDays,
        product: product,
        tonnageKg: item.tonnage * 1000,
        ratePerKg: item.price,
        status: 'DISPATCHED',
        dispatches: {
          create: {
            vehicleNumber: item.lorry,
            invoiceNumber: item.inv,
            invoiceDate: new Date(item.invDate),
            weightKg: item.rvpKata || item.tonnage * 1000,
            status: 'DISPATCHED',
          }
        }
      }
    });
    console.log(`Added missing ${product} order for ${item.company} (${item.lorry})`);
  }
}

async function run() {
  await addRecords(jithuMissing, 'Jithu');
  await addRecords(rvpMissing, 'RVP');
  await prisma.$disconnect();
}
run();
