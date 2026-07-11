import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const validData = [
  { date: '06-04-2026', party: 'Chhaya Industries', lorry: 'TN28BF7423', inv: 'RVP/01/26-27', tons: 25, price: 50.00 },
  { date: '08-04-2026', party: 'Adinath', lorry: 'TN28BF7498', inv: 'RVP/03/26-27', tons: 25, price: 50.50 },
  { date: '10-04-2026', party: 'Adinath', lorry: 'TN30AM0299', inv: 'RVP/04/26-27', tons: 25, price: 50.50 },
  { date: '12-04-2026', party: 'Srinivasa Agro', lorry: 'TN28BM9403', inv: 'RVP/05/26-27', tons: 30, price: 50.50 },
  { date: '13-04-2026', party: 'Chhaya Industries', lorry: 'KA56-8383', inv: 'RVP/07/26-27', tons: 35, price: 51.25 },
  { date: '14-04-2026', party: 'Chhaya Industries', lorry: 'TN28BF7423', inv: 'RVP/08/26-27', tons: 25, price: 50.50 },
  { date: '16-04-2026', party: 'Srinivasa Agro', lorry: 'TN52Q2882', inv: 'RVP/09/26-27', tons: 30, price: 50.50 },
  { date: '17-04-2026', party: 'Vimal Industries', lorry: 'AP04TU0561', inv: 'RVP/10/26-27', tons: 25, price: 53.25 },
  { date: '05-05-2026', party: 'Enegix', lorry: 'TN28BF7423', inv: 'RVP/13/26-27', tons: 25, price: 51.00 },
  { date: '06-05-2026', party: 'Enegix', lorry: 'TN28BF7498', inv: 'RVP/14/26-27', tons: 25, price: 51.00 },
  { date: '07-05-2026', party: 'Enegix', lorry: 'TN29DX2661', inv: 'RVP/15/26-27', tons: 30, price: 51.00 },
  { date: '08-05-2026', party: 'Enegix - Soham Agro', lorry: 'TN52AB3633', inv: 'RVP/16/26-27', tons: 30, price: 51.00 },
  { date: '09-05-2026', party: 'Enegix - Soham Agro', lorry: 'TN52M7456', inv: 'RVP/17/26-27', tons: 30, price: 51.00 },
  { date: '10-05-2026', party: 'Enegix - Soham Agro', lorry: 'TN52AD8526', inv: 'RVP/19/26-27', tons: 35, price: 51.00 },
  { date: '10-05-2026', party: 'Enegix', lorry: 'AP03TE9651', inv: 'RVP/20/26-27', tons: 25, price: 51.00 },
  { date: '12-05-2026', party: 'Soham Agro', lorry: 'TN28BM9403', inv: 'RVP/22/26-27', tons: 35, price: 52.00 },
  { date: '13-05-2026', party: 'Soham Agro', lorry: 'TN52AF8868', inv: 'RVP/23/26-27', tons: 35, price: 52.00 },
  { date: '13-05-2026', party: 'Colourtex', lorry: 'AP04TU0561', inv: 'RVP/24/26-27', tons: 25, price: 51.50 },
  { date: '15-05-2026', party: 'Enegix', lorry: 'KA09D1455', inv: 'RVP/26/26-27', tons: 30, price: 52.00 },
  { date: '16-05-2026', party: 'Enegix', lorry: 'TN90H8199', inv: 'RVP/28/26-27', tons: 30, price: 52.00 },
  { date: '17-05-2026', party: 'Colourtex', lorry: 'TN52P5108', inv: 'RVP/29/26-27', tons: 30, price: 52.00 },
  { date: '18-05-2026', party: 'Soham Agro', lorry: 'TN52AF4353', inv: 'RVP/31/26-27', tons: 35, price: 52.00 },
  { date: '19-05-2026', party: 'Spectrum', lorry: 'AP03TJ0150', inv: 'RVP/32/26-27', tons: 25, price: 51.50 },
  { date: '19-05-2026', party: 'Colourtex', lorry: 'TN83E2399', inv: 'RVP/34/26-27', tons: 30, price: 52.00 },
  { date: '20-05-2026', party: 'Soham Agro', lorry: 'TN52AE6064', inv: 'RVP/35/26-27', tons: 35, price: 52.00 },
  { date: '21-05-2026', party: 'Spectrum', lorry: 'TN28BF7498', inv: 'RVP/36/26-27', tons: 25, price: 51.50 },
  { date: '25-05-2026', party: 'Adinath', lorry: 'TN28BF7423', inv: 'RVP/39/26-27', tons: 25, price: 49.50 },
  { date: '27-05-2026', party: 'Soham Agro', lorry: 'TN52AB1937', inv: 'RVP/40/26-27', tons: 30, price: 50.50 },
  { date: '30-05-2026', party: 'Colourtex', lorry: 'TN90H8199', inv: 'RVP/41/26-27', tons: 30, price: 52.00 },
  { date: '30-05-2026', party: 'Colourtex', lorry: 'AP39U7475', inv: 'RVP/42/26-27', tons: 25, price: 51.50 },
  { date: '30-05-2026', party: 'Chhaya Industries', lorry: 'TN28BF7498', inv: 'RVP/43/26-27', tons: 25, price: 48.50 },
  { date: '31-05-2026', party: 'Colourtex', lorry: 'AP03TE3029', inv: 'RVP/44/26-27', tons: 25, price: 52.00 },
  { date: '31-05-2026', party: 'Colourtex', lorry: 'AP39WR0129', inv: 'RVP/45/26-27', tons: 35, price: 52.00 },
  { date: '02-06-2026', party: 'Colourtex', lorry: 'TN52M4755', inv: 'RVP/48/26-27', tons: 35, price: 52.00 },
  { date: '02-06-2026', party: 'Chhaya Industries', lorry: 'AP03TE7209', inv: 'RVP/49/26-27', tons: 30, price: 48.50 },
  { date: '02-06-2026', party: 'Spectrum', lorry: 'TN29CJ5779', inv: 'RVP/50/26-27', tons: 35, price: 49.50 },
  { date: '03-06-2026', party: 'Chhaya Industries', lorry: 'TN29CC9492', inv: 'RVP/51/26-27', tons: 30, price: 48.50 },
  { date: '04-06-2026', party: 'Chhaya Industries', lorry: 'TN36AK7378', inv: 'RVP/53/26-27', tons: 30, price: 48.50 },
  { date: '05-06-2026', party: 'Colourtex', lorry: 'TN52J9102', inv: 'RVP/54/26-27', tons: 30, price: 49.50 },
  { date: '07-06-2026', party: 'Colourtex', lorry: 'TN34AZ5349', inv: 'RVP/56/26-27', tons: 30, price: 49.50 },
  { date: '09-06-2026', party: 'Colourtex', lorry: 'TN86A6588', inv: 'RVP/58/26-27', tons: 30, price: 49.50 },
  { date: '11-06-2026', party: 'Colourtex', lorry: 'TN52P0705', inv: 'RVP/60/26-27', tons: 30, price: 49.50 },
  { date: '12-06-2026', party: 'Chhaya Industries', lorry: 'TN52K5931', inv: 'RVP/61/26-27', tons: 30, price: 47.50 },
  { date: '13-06-2026', party: 'Colourtex', lorry: 'AP39UF5999', inv: 'RVP/62/26-27', tons: 30, price: 49.50 },
  { date: '26-06-2026', party: 'Soham Agro', lorry: 'TN28BF7498', inv: 'RVP/68/26-27', tons: 25, price: 49.00 },
  { date: '26-06-2026', party: 'Soham Agro', lorry: 'TN28BF7423', inv: 'RVP/69/26-27', tons: 25, price: 49.00 },
  { date: '27-06-2026', party: 'Soham Agro', lorry: null, inv: 'RVP/71/26-27', tons: 35, price: 49.00 },
];

async function main() {
  const p = await prisma.saleOrder.findMany({ 
    where: { product: 'PAPPU' }, 
    include: { buyer: true, dispatches: true } 
  });

  console.log(`Found ${p.length} total PAPPU orders in DB.`);
  const toDelete = [];
  const toKeep = [];

  for (const row of p) {
    const d = row.dispatches[0];
    let inv = d?.invoiceNumber;
    if (inv && inv.match(/^\d+$/)) {
      inv = 'RVP/' + inv.padStart(2, '0') + '/26-27';
    }

    const matched = validData.find(v => v.inv === inv);
    if (matched) {
      toKeep.push(row);
      if (row.tonnageKg !== matched.tons * 1000 || row.ratePerKg !== String(matched.price)) {
        await prisma.saleOrder.update({
          where: { id: row.id },
          data: {
            tonnageKg: matched.tons * 1000,
            ratePerKg: String(matched.price)
          }
        });
        console.log(`Updated Order: ${inv}`);
      }
      if (d) {
        if (d.vehicleNumber !== matched.lorry) {
          await prisma.saleDispatch.update({
            where: { id: d.id },
            data: { vehicleNumber: matched.lorry }
          });
          console.log(`Updated Lorry for ${inv}: ${matched.lorry}`);
        }
      }
    } else {
      toDelete.push(row);
    }
  }

  console.log(`Found ${toDelete.length} orders to DELETE.`);
  for (const del of toDelete) {
    await prisma.saleAllocation.deleteMany({ where: { saleOrderId: del.id }});
    await prisma.saleDispatch.deleteMany({ where: { saleOrderId: del.id }});
    await prisma.saleOrder.delete({ where: { id: del.id }});
    console.log(`DELETED Excess Order: ${del.buyer.name} - ${del.tonnageKg/1000}T`);
  }
}
main();
