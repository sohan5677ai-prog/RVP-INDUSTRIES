import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const mustafa = [
  { inv: '4', date: '2026-04-06', invDate: '2026-04-10', company: 'Adinath', price: 50.50, due: '2026-04-14', tonnage: 25, lorry: 'TN30AM0299' },
  { inv: '5', date: '2026-04-10', invDate: '2026-04-12', company: 'Srinivasa Agro Ind', price: 50.50, due: '2026-04-21', tonnage: 30, lorry: 'TN28BM9403' },
  { inv: '9', date: '2026-04-10', invDate: '2026-04-16', company: 'Srinivasa Agro Ind', price: 50.50, due: '2026-04-25', tonnage: 30, lorry: 'TN52Q2882' },
  { inv: '24', date: '2026-05-05', invDate: '2026-05-13', company: 'Colourtex', price: 51.50, due: '2026-05-31', tonnage: 25, lorry: 'AP04TU0561' },
  { inv: '42', date: '2026-05-05', invDate: '2026-05-30', company: 'Colourtex', price: 51.50, due: '2026-06-17', tonnage: 25, lorry: 'AP39U7475' },
  { inv: '29', date: '2026-05-13', invDate: '2026-05-17', company: 'Colourtex', price: 52.00, due: '2026-06-04', tonnage: 30, lorry: 'TN52P5108' },
  { inv: '41', date: '2026-05-13', invDate: '2026-05-30', company: 'Colourtex', price: 52.00, due: '2026-06-17', tonnage: 30, lorry: 'TN90H8199' },
  { inv: '60', date: '2026-06-09', invDate: '2026-06-11', company: 'Colourtex', price: 49.50, due: '2026-07-14', tonnage: 30, lorry: 'TN52P0705' }
];

const jithu = [
  { inv: '3', date: '2026-04-06', invDate: '2026-04-08', company: 'Adinath', price: 50.50, due: '2026-04-12', tonnage: 25, lorry: 'TN28BF7498' },
  { inv: '10', date: '2026-04-14', invDate: '2026-04-17', company: 'Vimal Industries', price: 53.25, due: '2026-05-19', tonnage: 25, lorry: 'AP04TU0561' },
  { inv: '13', date: '2026-05-04', invDate: '2026-05-05', company: 'Enegix', price: 51.00, due: '2026-05-09', tonnage: 25, lorry: 'TN28BF7423' },
  { inv: '14', date: '2026-05-04', invDate: '2026-05-06', company: 'Enegix', price: 51.00, due: '2026-05-10', tonnage: 25, lorry: 'TN28BF7498' },
  { inv: '15', date: '2026-05-04', invDate: '2026-05-07', company: 'Enegix', price: 51.00, due: '2026-05-11', tonnage: 30, lorry: 'TN29DX2661' },
  { inv: '16', date: '2026-05-04', invDate: '2026-05-07', company: 'Enegix - Billed for Shahada', price: 51.00, due: '2026-05-11', tonnage: 30, lorry: 'TN52AB3633' },
  { inv: '17', date: '2026-05-04', invDate: '2026-05-09', company: 'Enegix - Billed for Shahada', price: 51.00, due: '2026-05-13', tonnage: 30, lorry: 'TN22M7456', rvpKata: 29720 },
  { inv: '19', date: '2026-05-04', invDate: '2026-05-10', company: 'Enegix - Billed for Shahada', price: 51.00, due: '2026-05-14', tonnage: 35, lorry: 'TN52AD8526', rvpKata: 34670 },
  { inv: '20', date: '2026-05-04', invDate: '2026-05-10', company: 'Enegix', price: 51.00, due: '2026-05-14', tonnage: 25, lorry: 'AP03TE9651' },
  { inv: '22', date: '2026-05-11', invDate: '2026-05-12', company: 'Soham Agro - Enegix Ref', price: 52.00, due: '2026-05-16', tonnage: 35, lorry: 'TN28BM9403' },
  { inv: '23', date: '2026-05-11', invDate: '2026-05-13', company: 'Soham Agro - Enegix Ref', price: 52.00, due: '2026-05-17', tonnage: 35, lorry: 'TN52AF8868' },
  { inv: '26', date: '2026-05-11', invDate: '2026-05-15', company: 'Enegix', price: 52.00, due: '2026-05-19', tonnage: 30, lorry: 'KA09D1455' },
  { inv: '28', date: '2026-05-11', invDate: '2026-05-16', company: 'Enegix', price: 52.00, due: '2026-05-20', tonnage: 30, lorry: 'TN90H8199' },
  { inv: '31', date: '2026-05-11', invDate: '2026-05-18', company: 'Soham Agro - Enegix Ref', price: 52.00, due: '2026-05-22', tonnage: 35, lorry: 'TN52AF4353' },
  { inv: '35', date: '2026-05-11', invDate: '2026-05-20', company: 'Soham Agro - Enegix Ref', price: 52.00, due: '2026-05-24', tonnage: 35, lorry: 'TN52AE6064' },
  { inv: '34', date: '2026-05-12', invDate: '2026-05-19', company: 'Colourtex', price: 52.00, due: '2026-06-06', tonnage: 30, lorry: 'TN83E2399' },
  { inv: '44', date: '2026-05-12', invDate: '2026-05-31', company: 'Colourtex', price: 52.00, due: '2026-06-18', tonnage: 25, lorry: 'AP03TE3029' },
  { inv: '45', date: '2026-05-13', invDate: '2026-05-31', company: 'Colourtex', price: 52.00, due: '2026-06-18', tonnage: 35, lorry: 'AP39WR0129' },
  { inv: '48', date: '2026-05-13', invDate: '2026-06-02', company: 'Colourtex', price: 52.00, due: '2026-06-20', tonnage: 30, lorry: 'TN52M4755' },
  { inv: '37', date: '2026-05-19', invDate: '2026-05-22', company: 'Choudhary Traders', price: 9.25, due: '2026-05-25', tonnage: 30, lorry: 'TN52M0483' },
  { inv: '40', date: '2026-05-25', invDate: '2026-05-27', company: 'Soham Agro', price: 50.50, due: '2026-06-14', tonnage: 30, lorry: 'TN52AB1937' },
  { inv: '54', date: '2026-06-02', invDate: '2026-06-05', company: 'Colourtex', price: 49.50, due: '2026-07-08', tonnage: 30, lorry: 'TN52J9102' },
  { inv: '56', date: '2026-06-02', invDate: '2026-06-07', company: 'Colourtex', price: 49.50, due: '2026-07-10', tonnage: 30, lorry: 'TN34AZ5349' },
  { inv: '58', date: '2026-06-08', invDate: '2026-06-09', company: 'Colourtex', price: 49.50, due: '2026-07-12', tonnage: 30, lorry: 'TN86A6588' },
  { inv: '62', date: '2026-06-09', invDate: '2026-06-13', company: 'Colourtex', price: 49.50, due: '2026-07-16', tonnage: 30, lorry: 'AP39UF5999' },
  { inv: '68', date: '2026-06-25', invDate: '2026-06-25', company: 'Soham Agro', price: 49.00, due: '2026-06-28', tonnage: 25, lorry: 'TN28BF7498' },
  { inv: '69', date: '2026-06-25', invDate: '2026-06-25', company: 'Soham Agro', price: 49.00, due: '2026-06-28', tonnage: 25, lorry: 'TN28BF7423' },
  { inv: '71', date: '2026-06-25', invDate: '2026-06-27', company: 'Soham Agro', price: 49.00, due: '2026-06-30', tonnage: 25, lorry: 'TN52AC2251' },
  { inv: '73', date: '2026-06-25', invDate: '2026-06-29', company: 'Soham Agro', price: 49.00, due: '2026-07-02', tonnage: 25, lorry: 'TN52AH1074' }
];

const rvp = [
  { inv: '1', date: '2026-04-06', invDate: '2026-04-06', company: 'Chhaya', price: 50.00, due: '2026-04-10', tonnage: 25, lorry: 'TN28BF7423' },
  { inv: '8', date: '2026-04-10', invDate: '2026-04-14', company: 'Chhaya', price: 50.50, due: '2026-04-21', tonnage: 25, lorry: 'TN28BF7423' },
  { inv: '7', date: '2026-04-12', invDate: '2026-04-13', company: 'Chhaya', price: 51.25, due: '2026-04-20', tonnage: 35, lorry: 'KA568383' },
  { inv: '18', date: '2026-05-01', invDate: '2026-05-09', company: 'Balaji Challakere', price: 6.90, tonnage: 25, lorry: 'TN52H8879' },
  { inv: '21', date: '2026-05-01', invDate: '2026-05-11', company: 'Balaji Challakere', price: 6.90, tonnage: 25, lorry: 'TN29BZ4108' },
  { inv: '57', date: '2026-05-02', invDate: '2026-06-08', company: 'Vinod Salem', price: 7.00, tonnage: 25, lorry: 'AP21TY9936' },
  { inv: '32', date: '2026-05-04', invDate: '2026-05-19', company: 'Spectrum', price: 51.50, due: '2026-06-20', tonnage: 25, lorry: 'AP03TJ0150' },
  { inv: '36', date: '2026-05-04', invDate: '2026-05-21', company: 'Spectrum', price: 51.50, due: '2026-06-22', tonnage: 25, lorry: 'TN28BF7498' },
  { inv: '25', date: '2026-05-10', invDate: '2026-05-14', company: 'Balaji Challakere', price: 6.90, tonnage: 25, lorry: 'TN34V7817' },
  { inv: '27', date: '2026-05-10', invDate: '2026-05-16', company: 'Balaji Challakere', price: 6.90, tonnage: 25, lorry: 'TN29BT4946' },
  { inv: '30', date: '2026-05-15', invDate: '2026-05-17', company: 'Balaji Challakere', price: 6.95, tonnage: 25, lorry: 'AP02TC1023' },
  { inv: '38', date: '2026-05-15', invDate: '2026-05-24', company: 'Balaji Challakere', price: 6.95, tonnage: 25, lorry: 'TN48AD7504' },
  { inv: '46', date: '2026-05-15', invDate: '2026-05-31', company: 'Balaji Challakere', price: 6.95, tonnage: 25, lorry: 'TN54P0019' },
  { inv: '39', date: '2026-05-25', invDate: '2026-05-25', company: 'Adinath', price: 49.50, tonnage: 25, lorry: 'TN28BF7423', rvpKata: 24830 },
  { inv: '47', date: '2026-05-30', invDate: '2026-06-01', company: 'Balaji Challakere', price: 6.95, tonnage: 25, lorry: 'TN52Q1375' },
  { inv: '52', date: '2026-05-30', invDate: '2026-06-03', company: 'Balaji Challakere', price: 6.95, tonnage: 25, lorry: 'AP21TA1395' },
  { inv: '43', date: '2026-05-30', invDate: '2026-05-30', company: 'Chhaya', price: 48.50, due: '2026-06-07', tonnage: 25, lorry: 'TN28BF7498' },
  { inv: '49', date: '2026-05-30', invDate: '2026-06-02', company: 'Chhaya', price: 48.50, due: '2026-06-10', tonnage: 25, lorry: 'AP03TE7209' },
  { inv: '50', date: '2026-06-01', invDate: '2026-06-02', company: 'Spectrum', price: 49.50, due: '2026-07-04', tonnage: 35, lorry: 'TN29CJ5779' },
  { inv: '51', date: '2026-06-02', invDate: '2026-06-03', company: 'Chhaya', price: 48.50, due: '2026-06-12', tonnage: 30, lorry: 'TN29CC9492' },
  { inv: '53', date: '2026-06-02', invDate: '2026-06-04', company: 'Chhaya', price: 48.50, due: '2026-06-13', tonnage: 30, lorry: 'TN36AK7378' },
  { inv: '55', date: '2026-06-05', invDate: '2026-06-05', company: 'SLV Babu', price: 7.50, tonnage: 28, lorry: 'TN28BF7423' },
  { inv: '59', date: '2026-06-04', invDate: '2026-06-10', company: 'Balaji Challakere', price: 6.95, tonnage: 25, lorry: 'TN25BF3740' },
  { inv: '63', date: '2026-06-04', invDate: '2026-06-14', company: 'Balaji Challakere', price: 6.95, tonnage: 25, lorry: 'TN52F7055' },
  { inv: '64', date: '2026-06-04', invDate: '2026-06-16', company: 'Balaji Challakere', price: 6.95, tonnage: 25, lorry: 'TN52H5492' },
  { inv: '66', date: '2026-06-04', invDate: '2026-06-19', company: 'Balaji Challakere', price: 6.95, tonnage: 25, lorry: 'TN34W3799' },
  { inv: '61', date: '2026-06-08', invDate: '2026-06-12', company: 'Chhaya', price: 47.50, due: '2026-06-20', tonnage: 30, lorry: 'TN52K5931' },
  { inv: '65', date: '2026-06-17', invDate: '2026-06-17', company: 'MSV Vasanth', price: 8.00, tonnage: 15.55, lorry: 'AP39UX9105' },
  { inv: '67', date: '2026-06-20', invDate: '2026-06-24', company: 'Balaji Challakere', price: 7.10, tonnage: 25.5, lorry: 'TN52D5808' },
  { inv: '70', date: '2026-06-25', invDate: '2026-06-25', company: 'MSV Vasanth', price: 8.30, tonnage: 16.02, lorry: 'AP39UX9105' }
];

async function updateRecords(arr: any[], brokerName: string) {
  const broker = await prisma.broker.findFirst({ where: { name: brokerName }});
  const brokerId = broker?.id;

  for (const item of arr) {
    // Instead of findFirst randomly, let's match the exact entry based on the Invoice Date initially
    // or Lorry Number! The DB's SaleDate is actually the Invoice Date in most cases.
    // Wait, let's just get ALL orders for this party and filter by lorry or tonnage
    const parties = await prisma.party.findMany();
    const party = parties.find(p => p.name.toLowerCase().includes(item.company.toLowerCase().split(' ')[0]));
    if (!party) { console.log('Party not found:', item.company); continue; }

    let order = null;
    
    // First try by lorry if available
    if (item.lorry) {
      order = await prisma.saleOrder.findFirst({
        where: {
          buyerId: party.id,
          dispatches: { some: { vehicleNumber: { contains: item.lorry } } }
        },
        include: { dispatches: true }
      });
    }

    // Fallback: try by Invoice Number if it already matched once
    if (!order && item.inv) {
      order = await prisma.saleOrder.findFirst({
        where: {
          buyerId: party.id,
          dispatches: { some: { invoiceNumber: String(item.inv) } }
        },
        include: { dispatches: true }
      });
    }
    
    // Fallback: try by tonnage and approximate saleDate (the db's saleDate is probably the invoice date)
    if (!order) {
      order = await prisma.saleOrder.findFirst({
        where: {
          buyerId: party.id,
          tonnageKg: { gte: item.tonnage * 1000 - 1000, lte: item.tonnage * 1000 + 1000 },
          saleDate: { gte: new Date(new Date(item.invDate).getTime() - 86400000*3), lte: new Date(new Date(item.invDate).getTime() + 86400000*3) },
        },
        include: { dispatches: true }
      });
    }

    if (order) {
      let dueDays = null;
      if (item.due && item.invDate) {
        dueDays = Math.round((new Date(item.due).getTime() - new Date(item.invDate).getTime()) / 86400000);
      }
      
      await prisma.saleOrder.update({
        where: { id: order.id },
        data: {
          brokerId: brokerId,
          saleDate: new Date(item.date),
          dueDays: dueDays,
        }
      });

      if (order.dispatches.length > 0) {
        await prisma.saleDispatch.update({
          where: { id: order.dispatches[0].id },
          data: {
            vehicleNumber: item.lorry,
            invoiceNumber: String(item.inv),
            invoiceDate: new Date(item.invDate),
            weightKg: item.rvpKata || order.dispatches[0].weightKg
          }
        });
      }
      console.log('Fixed', item.company, item.inv);
    } else {
      console.log('Still not found', item.company, item.invDate, item.lorry);
    }
  }
}

async function run() {
  await updateRecords(mustafa, 'Mustafa');
  await updateRecords(jithu, 'Jithu');
  await updateRecords(rvp, 'RVP');
  await prisma.$disconnect();
}
run();
