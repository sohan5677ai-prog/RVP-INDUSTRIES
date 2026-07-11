import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const data = [{ date: '2026-04-07', party: 'Gangadhar', lorryNo: 'TN524070', invoice: 'RVP/02/26-27', tons: 12.12, price: 7.00 },
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
    const correctDate = new Date(row.date);
    
    const weightKg = Math.round(row.tons * 1000);
    // Find dispatch
    const dispatch = await prisma.saleDispatch.findFirst({
        where: { vehicleNumber: row.lorryNo, weightKg, saleOrder: { product: 'HUSK' } },
        include: { saleOrder: true }
    });
    
    if (!dispatch) {
        console.log(`Dispatch not found for ${row.invoice}`);
        continue;
    }
    
    // Update order and dispatch dates
    await prisma.saleOrder.update({
        where: { id: dispatch.saleOrderId },
        data: { saleDate: correctDate }
    });
    
    await prisma.saleDispatch.update({
        where: { id: dispatch.id },
        data: { 
            dispatchDate: correctDate, 
            invoiceDate: correctDate,
            invoiceNumber: row.invoice,
            invoiceSeq: parseInt(row.invoice.split('/')[1], 10),
            invoiceFy: '2026-27'
        }
    });
    
    // Find journal entry
    const tx = await prisma.journalEntry.findFirst({
        where: { reference: `SALE-${dispatch.saleOrderId}` }
    });
    
    if (tx) {
        await prisma.journalEntry.update({
            where: { id: tx.id },
            data: { date: correctDate }
        });
        
        // Note: JournalLine does not have a date field, it belongs to JournalEntry
    }
    
    console.log(`Updated dates for ${row.invoice} to ${row.date}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
