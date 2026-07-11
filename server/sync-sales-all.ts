import { PrismaClient, SaleProduct, SaleStatus } from '@prisma/client';
const prisma = new PrismaClient();

const mustafa = [
  { inv: '4', date: '06-04-2026', invDate: '10-04-2026', company: 'Adinath', price: 50.50, due: '14-04-2026', tonnage: 25, lorry: 'TN30AM0299' },
  { inv: '5', date: '10-04-2026', invDate: '12-04-2026', company: 'Srinivasa Agro Ind', price: 50.50, due: '21-04-2026', tonnage: 30, lorry: 'TN28BM9403' },
  { inv: '9', date: '10-04-2026', invDate: '16-04-2026', company: 'Srinivasa Agro Ind', price: 50.50, due: '25-04-2026', tonnage: 30, lorry: 'TN52Q2882' },
  { inv: '24', date: '05-05-2026', invDate: '13-05-2026', company: 'Colourtex', price: 51.50, due: '31-05-2026', tonnage: 25, lorry: 'AP04TU0561' },
  { inv: '42', date: '05-05-2026', invDate: '30-05-2026', company: 'Colourtex', price: 51.50, due: '17-06-2026', tonnage: 25, lorry: 'AP39U7475' },
  { inv: '29', date: '13-05-2026', invDate: '17-05-2026', company: 'Colourtex', price: 52.00, due: '04-06-2026', tonnage: 30, lorry: 'TN52P5108' },
  { inv: '41', date: '13-05-2026', invDate: '30-05-2026', company: 'Colourtex', price: 52.00, due: '17-06-2026', tonnage: 30, lorry: 'TN90H8199' },
  { inv: '60', date: '09-06-2026', invDate: '11-06-2026', company: 'Colourtex', price: 49.50, due: '14-07-2026', tonnage: 30, lorry: 'TN52P0705' }
];

const jithu = [
  { inv: '3', date: '06-04-2026', invDate: '08-04-2026', company: 'Adinath', price: 50.50, due: '12-04-2026', tonnage: 25, lorry: 'TN28BF7498' },
  { inv: '10', date: '14-04-2026', invDate: '17-04-2026', company: 'Vimal Industries', price: 53.25, due: '19-05-2026', tonnage: 25, lorry: 'AP04TU0561' },
  { inv: '13', date: '04-05-2026', invDate: '05-05-2026', company: 'Enegix', price: 51.00, due: '09-05-2026', tonnage: 25, lorry: 'TN28BF7423' },
  { inv: '14', date: '04-05-2026', invDate: '06-05-2026', company: 'Enegix', price: 51.00, due: '10-05-2026', tonnage: 25, lorry: 'TN28BF7498' },
  { inv: '15', date: '04-05-2026', invDate: '07-05-2026', company: 'Enegix', price: 51.00, due: '11-05-2026', tonnage: 30, lorry: 'TN29DX2661' },
  { inv: '16', date: '04-05-2026', invDate: '07-05-2026', company: 'Enegix - Billed for Shahada', price: 51.00, due: '11-05-2026', tonnage: 30, lorry: 'TN52AB3633' },
  { inv: '17', date: '04-05-2026', invDate: '09-05-2026', company: 'Enegix - Billed for Shahada', price: 51.00, due: '13-05-2026', tonnage: 30, lorry: 'TN22M7456', rvpKata: 29720 },
  { inv: '19', date: '04-05-2026', invDate: '10-05-2026', company: 'Enegix - Billed for Shahada', price: 51.00, due: '14-05-2026', tonnage: 35, lorry: 'TN52AD8526', rvpKata: 34670 },
  { inv: '20', date: '04-05-2026', invDate: '10-05-2026', company: 'Enegix', price: 51.00, due: '14-05-2026', tonnage: 25, lorry: 'AP03TE9651' },
  { inv: '22', date: '11-05-2026', invDate: '12-05-2026', company: 'Soham Agro - Enegix Ref', price: 52.00, due: '16-05-2026', tonnage: 35, lorry: 'TN28BM9403' },
  { inv: '23', date: '11-05-2026', invDate: '13-05-2026', company: 'Soham Agro - Enegix Ref', price: 52.00, due: '17-05-2026', tonnage: 35, lorry: 'TN52AF8868' },
  { inv: '26', date: '11-05-2026', invDate: '15-05-2026', company: 'Enegix', price: 52.00, due: '19-05-2026', tonnage: 30, lorry: 'KA09D1455' },
  { inv: '28', date: '11-05-2026', invDate: '16-05-2026', company: 'Enegix', price: 52.00, due: '20-05-2026', tonnage: 30, lorry: 'TN90H8199' },
  { inv: '31', date: '11-05-2026', invDate: '18-05-2026', company: 'Soham Agro - Enegix Ref', price: 52.00, due: '22-05-2026', tonnage: 35, lorry: 'TN52AF4353' },
  { inv: '35', date: '11-05-2026', invDate: '20-05-2026', company: 'Soham Agro - Enegix Ref', price: 52.00, due: '24-05-2026', tonnage: 35, lorry: 'TN52AE6064' },
  { inv: '34', date: '12-05-2026', invDate: '19-05-2026', company: 'Colourtex', price: 52.00, due: '06-06-2026', tonnage: 30, lorry: 'TN83E2399' },
  { inv: '44', date: '12-05-2026', invDate: '31-05-2026', company: 'Colourtex', price: 52.00, due: '18-06-2026', tonnage: 25, lorry: 'AP03TE3029' },
  { inv: '45', date: '13-05-2026', invDate: '31-05-2026', company: 'Colourtex', price: 52.00, due: '18-06-2026', tonnage: 35, lorry: 'AP39WR0129' },
  { inv: '48', date: '13-05-2026', invDate: '02-06-2026', company: 'Colourtex', price: 52.00, due: '20-06-2026', tonnage: 30, lorry: 'TN52M4755' },
  { inv: '37', date: '19-05-2026', invDate: '22-05-2026', company: 'Choudhari Traders', price: 9.25, due: '25-05-2026', tonnage: 30, lorry: 'TN52M0483' },
  { inv: '40', date: '25-05-2026', invDate: '27-05-2026', company: 'Soham Agro', price: 50.50, due: '14-06-2026', tonnage: 30, lorry: 'TN52AB1937' },
  { inv: '54', date: '02-06-2026', invDate: '05-06-2026', company: 'Colourtex', price: 49.50, due: '08-07-2026', tonnage: 30, lorry: 'TN52J9102' },
  { inv: '56', date: '02-06-2026', invDate: '07-06-2026', company: 'Colourtex', price: 49.50, due: '10-07-2026', tonnage: 30, lorry: 'TN34AZ5349' },
  { inv: '58', date: '08-06-2026', invDate: '09-06-2026', company: 'Colourtex', price: 49.50, due: '12-07-2026', tonnage: 30, lorry: 'TN86A6588' },
  { inv: '62', date: '09-06-2026', invDate: '13-06-2026', company: 'Colourtex', price: 49.50, due: '16-07-2026', tonnage: 30, lorry: 'AP39UF5999' },
  { inv: '68', date: '25-06-2026', invDate: '25-06-2026', company: 'Soham Agro', price: 49.00, due: '28-06-2026', tonnage: 25, lorry: 'TN28BF7498' },
  { inv: '69', date: '25-06-2026', invDate: '25-06-2026', company: 'Soham Agro', price: 49.00, due: '28-06-2026', tonnage: 25, lorry: 'TN28BF7423' },
  { inv: '71', date: '25-06-2026', invDate: '27-06-2026', company: 'Soham Agro', price: 49.00, due: '30-06-2026', tonnage: 25, lorry: 'TN52AC2251' },
  { inv: '73', date: '25-06-2026', invDate: '29-06-2026', company: 'Soham Agro', price: 49.00, due: '02-07-2026', tonnage: 25, lorry: 'TN52AH1074' }
];

const rvp = [
  { inv: '1', date: '06-04-2026', invDate: '06-04-2026', company: 'Chhaya', price: 50.00, due: '10-04-2026', tonnage: 25, lorry: 'TN28BF7423' },
  { inv: '8', date: '10-04-2026', invDate: '14-04-2026', company: 'Chhaya', price: 50.50, due: '21-04-2026', tonnage: 25, lorry: 'TN28BF7423' },
  { inv: '7', date: '12-04-2026', invDate: '13-04-2026', company: 'Chhaya', price: 51.25, due: '20-04-2026', tonnage: 35, lorry: 'KA568383' },
  { inv: '18', date: '01-05-2026', invDate: '09-05-2026', company: 'Balaji Challakere', price: 6.90, tonnage: 25, lorry: 'TN52H8879' },
  { inv: '21', date: '01-05-2026', invDate: '11-05-2026', company: 'Balaji Challakere', price: 6.90, tonnage: 25, lorry: 'TN29BZ4108' },
  { inv: '57', date: '02-05-2026', invDate: '08-06-2026', company: 'Vinod Salem', price: 7.00, tonnage: 25, lorry: 'AP21TY9936' },
  { inv: '32', date: '04-05-2026', invDate: '19-05-2026', company: 'Spectrum', price: 51.50, due: '20-06-2026', tonnage: 25, lorry: 'AP03TJ0150' },
  { inv: '36', date: '04-05-2026', invDate: '21-05-2026', company: 'Spectrum', price: 51.50, due: '22-06-2026', tonnage: 25, lorry: 'TN28BF7498' },
  { inv: '25', date: '10-05-2026', invDate: '14-05-2026', company: 'Balaji Challakere', price: 6.90, tonnage: 25, lorry: 'TN34V7817' },
  { inv: '27', date: '10-05-2026', invDate: '16-05-2026', company: 'Balaji Challakere', price: 6.90, tonnage: 25, lorry: 'TN29BT4946' },
  { inv: '30', date: '15-05-2026', invDate: '17-05-2026', company: 'Balaji Challakere', price: 6.95, tonnage: 25, lorry: 'AP02TC1023' },
  { inv: '33', date: '15-05-2026', invDate: '19-05-2026', company: 'Balaji Challakere', price: 6.95, tonnage: 25 },
  { inv: '38', date: '15-05-2026', invDate: '24-05-2026', company: 'Balaji Challakere', price: 6.95, tonnage: 25, lorry: 'TN48AD7504' },
  { inv: '46', date: '15-05-2026', invDate: '31-05-2026', company: 'Balaji Challakere', price: 6.95, tonnage: 25, lorry: 'TN54P0019' },
  { inv: '39', date: '25-05-2026', invDate: '25-05-2026', company: 'Adinath', price: 49.50, tonnage: 25, lorry: 'TN28BF7423', rvpKata: 24830 },
  { inv: '47', date: '30-05-2026', invDate: '01-06-2026', company: 'Balaji Challakere', price: 6.95, tonnage: 25, lorry: 'TN52Q1375' },
  { inv: '52', date: '30-05-2026', invDate: '03-06-2026', company: 'Balaji Challakere', price: 6.95, tonnage: 25, lorry: 'AP21TA1395' },
  { inv: '43', date: '30-05-2026', invDate: '30-05-2026', company: 'Chhaya', price: 48.50, due: '07-06-2026', tonnage: 25, lorry: 'TN28BF7498' },
  { inv: '49', date: '30-05-2026', invDate: '02-06-2026', company: 'Chhaya', price: 48.50, due: '10-06-2026', tonnage: 25, lorry: 'AP03TE7209' },
  { inv: '50', date: '01-06-2026', invDate: '02-06-2026', company: 'Spectrum', price: 49.50, due: '04-07-2026', tonnage: 35, lorry: 'TN29CJ5779' },
  { inv: '51', date: '02-06-2026', invDate: '03-06-2026', company: 'Chhaya', price: 48.50, due: '12-06-2026', tonnage: 30, lorry: 'TN29CC9492' },
  { inv: '53', date: '02-06-2026', invDate: '04-06-2026', company: 'Chhaya', price: 48.50, due: '13-06-2026', tonnage: 30, lorry: 'TN36AK7378' },
  { inv: '55', date: '05-06-2026', invDate: '05-06-2026', company: 'SLV Babu', price: 7.50, tonnage: 28, lorry: 'TN28BF7423' },
  { inv: '59', date: '04-06-2026', invDate: '10-06-2026', company: 'Balaji Challakere', price: 6.95, tonnage: 25, lorry: 'TN25BF3740' },
  { inv: '63', date: '04-06-2026', invDate: '14-06-2026', company: 'Balaji Challakere', price: 6.95, tonnage: 25, lorry: 'TN52F7055' },
  { inv: '64', date: '04-06-2026', invDate: '16-06-2026', company: 'Balaji Challakere', price: 6.95, tonnage: 25, lorry: 'TN52H5492' },
  { inv: '66', date: '04-06-2026', invDate: '19-06-2026', company: 'Balaji Challakere', price: 6.95, tonnage: 25, lorry: 'TN34W3799' },
  { inv: '61', date: '08-06-2026', invDate: '12-06-2026', company: 'Chhaya', price: 47.50, due: '20-06-2026', tonnage: 30, lorry: 'TN52K5931' },
  { inv: '65', date: '17-06-2026', invDate: '17-06-2026', company: 'MSV Trading', price: 8.00, lorry: 'AP39UX9105' },
  { inv: '67', date: '20-06-2026', invDate: '24-06-2026', company: 'Balaji Challakere', price: 7.10, tonnage: 25, lorry: 'TN52D5808' },
  { inv: '70', date: '25-06-2026', invDate: '25-06-2026', company: 'MSV Trading', price: 8.30, tonnage: 16.02, lorry: 'AP39UX9105' }
];

function parseDate(d) {
  const [day, month, year] = d.split('-');
  return new Date(`${year}-${month}-${day}T00:00:00Z`);
}

async function syncAll() {
  const parties = await prisma.party.findMany();
  const brokers = await prisma.broker.findMany();
  
  let validOrderIds = [];
  
  const processGroup = async (arr, brokerName) => {
    let brokerId = null;
    if (brokerName) {
      brokerId = brokers.find(b => b.name.includes(brokerName))?.id;
    }
    
    for (const item of arr) {
      const saleDate = parseDate(item.date);
      const invoiceDate = item.invDate ? parseDate(item.invDate) : null;
      let dueDays = null;
      if (item.due && invoiceDate) {
         const dueDate = parseDate(item.due);
         dueDays = Math.round((dueDate.getTime() - invoiceDate.getTime()) / 86400000);
      }
      
      const party = parties.find(p => p.name.toLowerCase().replace(/[^a-z0-9]/g, '') === item.company.toLowerCase().replace(/[^a-z0-9]/g, '') ||
                                       p.name.toLowerCase().includes(item.company.toLowerCase().split(' ')[0]));
                                       
      if (!party) {
        console.log('Skipping unknown party:', item.company);
        continue;
      }
      
      const product = item.price > 20 ? SaleProduct.PAPPU : SaleProduct.HUSK;
      const invString = 'RVP/' + item.inv.padStart(2, '0') + '/26-27';
      const weightKg = item.rvpKata || Math.round((item.tonnage || 0) * 1000);
      
      // Look for an existing dispatch with this invoice number OR an order for this party/date
      let existingDispatch = await prisma.saleDispatch.findFirst({
         where: { invoiceNumber: invString },
         include: { saleOrder: true }
      });
      
      let orderToUpdate = null;
      if (existingDispatch) {
         orderToUpdate = existingDispatch.saleOrder;
      } else {
         orderToUpdate = await prisma.saleOrder.findFirst({
           where: {
              buyerId: party.id,
              product: product,
              tonnageKg: Math.round((item.tonnage || 0) * 1000),
              saleDate: {
                 gte: new Date(saleDate.getTime() - 86400000 * 3),
                 lte: new Date(saleDate.getTime() + 86400000 * 3)
              }
           }
         });
      }
      
      if (orderToUpdate) {
         // Update existing
         await prisma.saleOrder.update({
            where: { id: orderToUpdate.id },
            data: {
               saleDate: saleDate,
               brokerId: brokerId,
               dueDays: dueDays,
               ratePerKg: item.price,
               tonnageKg: Math.round((item.tonnage || 0) * 1000)
            }
         });
         
         const dispatch = await prisma.saleDispatch.findFirst({ where: { saleOrderId: orderToUpdate.id } });
         if (dispatch) {
            await prisma.saleDispatch.update({
               where: { id: dispatch.id },
               data: {
                  invoiceNumber: invString,
                  invoiceDate: invoiceDate || saleDate,
                  vehicleNumber: item.lorry || dispatch.vehicleNumber,
                  weightKg: weightKg
               }
            });
         }
         validOrderIds.push(orderToUpdate.id);
      } else {
         // Create new
         console.log('Creating new order for', item.company, invString, product);
         const newOrder = await prisma.saleOrder.create({
            data: {
               saleDate: saleDate,
               product: product,
               buyerId: party.id,
               brokerId: brokerId,
               tonnageKg: Math.round((item.tonnage || 0) * 1000),
               ratePerKg: item.price,
               dueDays: dueDays,
               status: SaleStatus.DISPATCHED,
               dispatches: {
                  create: {
                     dispatchDate: saleDate,
                     vehicleNumber: item.lorry || 'UNKNOWN',
                     weightKg: weightKg,
                     invoiceNumber: invString,
                     invoiceDate: invoiceDate || saleDate
                  }
               }
            }
         });
         validOrderIds.push(newOrder.id);
      }
    }
  };
  
  await processGroup(mustafa, 'Mustafa');
  await processGroup(jithu, 'Jithu');
  await processGroup(rvp, null);
  
  // Now delete ANY SaleOrder that is NOT in validOrderIds
  const allOrders = await prisma.saleOrder.findMany();
  let deletedCount = 0;
  for (const o of allOrders) {
     if (!validOrderIds.includes(o.id)) {
        await prisma.saleDispatch.deleteMany({ where: { saleOrderId: o.id } });
        // NOTE: If there are allocations or ledger entries, this will fail. Let's try...
        try {
          await prisma.saleOrder.delete({ where: { id: o.id } });
          deletedCount++;
        } catch (e) {
          console.log('Could not delete order', o.id, e.message);
        }
     }
  }
  console.log(`Deleted ${deletedCount} extra orders.`);
  
  const finalOrders = await prisma.saleOrder.findMany({ include: { dispatches: true } });
  console.log(`Final count: ${finalOrders.length}`);
}

syncAll().catch(console.error).finally(() => prisma.$disconnect());
