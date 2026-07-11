import { PrismaClient } from '@prisma/client';
import { signToken } from './src/lib/jwt.js';
const prisma = new PrismaClient();

const data = [
  { date: '2026-04-07', party: 'Gangadhar', lorryNo: 'TN524070', invoice: 'RVP/02/26-27', tons: 12.12, price: 7.00 },
  { date: '2026-04-13', party: 'SLV Babu', lorryNo: 'TN524070', invoice: 'RVP/06/26-27', tons: 26.50, price: 7.50 },
  { date: '2026-04-17', party: 'Gangadhar', lorryNo: 'TN524070', invoice: 'RVP/11/26-27', tons: 24.85, price: 7.50 },
  { date: '2026-05-01', party: 'KTC', lorryNo: 'TN52F6431', invoice: 'RVP/12/26-27', tons: 25.03, price: 7.00 },
  { date: '2026-05-09', party: 'Balaji Challakere', lorryNo: 'TN52H8879', invoice: 'RVP/18/26-27', tons: 24.91, price: 6.90 },
  { date: '2026-05-11', party: 'Balaji Challakere', lorryNo: 'TN29BZ4108', invoice: 'RVP/21/26-27', tons: 24.76, price: 6.90 },
  { date: '2026-05-14', party: 'Balaji Challakere', lorryNo: 'TN34V7817', invoice: 'RVP/25/26-27', tons: 26.06, price: 6.90 },
  { date: '2026-05-16', party: 'Balaji Challakere', lorryNo: 'TN29BT4946', invoice: 'RVP/27/26-27', tons: 25.55, price: 6.90 },
  { date: '2026-05-17', party: 'Balaji Challakere', lorryNo: 'AP02TC1023', invoice: 'RVP/30/26-27', tons: 25.10, price: 6.95 },
  { date: '2026-05-19', party: 'Balaji Challakere', lorryNo: 'TN69BA4582', invoice: 'RVP/33/26-27', tons: 26.53, price: 6.95 },
  { date: '2026-05-22', party: 'Choudhary Traders', lorryNo: 'TN52M0483', invoice: 'RVP/37/26-27', tons: 30.25, price: 6.72 },
  { date: '2026-05-24', party: 'Balaji Challakere', lorryNo: 'TN48AD7504', invoice: 'RVP/38/26-27', tons: 28.17, price: 6.95 },
  { date: '2026-05-31', party: 'Balaji Challakere', lorryNo: 'TN54P0019', invoice: 'RVP/46/26-27', tons: 25.46, price: 6.95 },
  { date: '2026-06-01', party: 'Balaji Challakere', lorryNo: 'TN52Q1375', invoice: 'RVP/47/26-27', tons: 25.90, price: 6.95 },
  { date: '2026-06-03', party: 'Balaji Challakere', lorryNo: 'AP21TA1395', invoice: 'RVP/52/26-27', tons: 26.09, price: 6.95 },
  { date: '2026-06-06', party: 'SLV Babu', lorryNo: 'TN28BF7423', invoice: 'RVP/55/26-27', tons: 28.45, price: 7.50 },
  { date: '2026-06-08', party: 'Balaji Challakere', lorryNo: 'AP21TY9936', invoice: 'RVP/57/26-27', tons: 26.63, price: 7.00 },
  { date: '2026-06-10', party: 'Balaji Challakere', lorryNo: 'TN25BF3740', invoice: 'RVP/59/26-27', tons: 29.37, price: 6.95 },
  { date: '2026-06-14', party: 'Balaji Challakere', lorryNo: 'TN52F7055', invoice: 'RVP/63/26-27', tons: 25.22, price: 6.95 },
  { date: '2026-06-16', party: 'Balaji Challakere', lorryNo: 'TN52H5492', invoice: 'RVP/64/26-27', tons: 25.01, price: 6.95 },
  { date: '2026-06-17', party: 'MSV Vasanth', lorryNo: 'AP39UX9105', invoice: 'RVP/65/26-27', tons: 15.55, price: 7.00 },
  { date: '2026-06-19', party: 'Balaji Challakere', lorryNo: 'TN34W3799', invoice: 'RVP/66/26-27', tons: 25.61, price: 6.95 },
  { date: '2026-06-24', party: 'Balaji Challakere', lorryNo: 'TN52D5808', invoice: 'RVP/67/26-27', tons: 25.50, price: 7.10 },
  { date: '2026-06-25', party: 'MSV Vasanth', lorryNo: 'AP39UX9105', invoice: 'RVP/70/26-27', tons: 16.02, price: 7.30 },
  { date: '2026-06-27', party: 'Vinod Salem', lorryNo: 'TN88A6266', invoice: 'RVP/72/26-27', tons: 25.02, price: 7.20 },
];

async function main() {
  for (const row of data) {
    let party = await prisma.party.findFirst({ where: { name: row.party } });
    if (!party) {
      party = await prisma.party.create({
        data: { name: row.party, type: 'BUYER', commodities: ['HUSK'] },
      });
      console.log(`Created party: ${row.party}`);
    } else {
        if (!party.commodities.includes('HUSK')) {
            await prisma.party.update({
                where: { id: party.id },
                data: { commodities: { push: 'HUSK' } }
            });
        }
    }

    const weightKg = Math.round(row.tons * 1000);
    const saleDate = new Date(row.date).toISOString();
    const token = signToken({ userId: 'dummy', role: 'ADMIN' });
    
    // 1. Create Sale Order via API
    const orderRes = await fetch('http://localhost:4000/api/sale-orders', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        saleDate,
        product: 'HUSK',
        buyerId: party.id,
        tonnageKg: weightKg,
        ratePerKg: row.price.toString()
      })
    });
    
    if (!orderRes.ok) {
        console.error(`Failed to create order for ${row.invoice}`, await orderRes.text());
        continue;
    }
    const order = await orderRes.json();

    // 2. Create Dispatch via API
    const dispatchRes = await fetch(`http://localhost:4000/api/sale-orders/${order.id}/dispatch`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        dispatchDate: saleDate,
        tonnageKg: weightKg,
        vehicleNumber: row.lorryNo,
        invoiceNumber: row.invoice,
      })
    });

    if (!dispatchRes.ok) {
        console.error(`Failed to create dispatch for ${row.invoice}`, await dispatchRes.text());
        continue;
    }

    // 3. Update the dispatch invoice dates manually just in case API uses current date
    const seqStr = row.invoice.split('/')[1];
    const seq = parseInt(seqStr, 10);
    const dispatch = await dispatchRes.json();
    await prisma.saleDispatch.update({
        where: { id: dispatch.id },
        data: {
            invoiceDate: new Date(row.date),
            invoiceSeq: seq,
            invoiceFy: '2026-27'
        }
    });

    console.log(`Successfully loaded Husk sale: ${row.invoice} - ${row.party}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
