import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// [date, buyerName, lorryNo, invoiceNo, netTonnes, pricePerKg]
type Row = [string, string, string, string, number, number];

const ROWS: Row[] = [
  ['2026-04-06', 'Chhaya Industries', 'TN28BF7423', 'RVP/01/26-27', 25, 50.00],
  ['2026-04-08', 'Adinath', 'TN28BF7498', 'RVP/03/26-27', 25, 50.50],
  ['2026-04-10', 'Adinath', 'TN30AM0299', 'RVP/04/26-27', 25, 50.50],
  ['2026-04-12', 'Srinivasa Agro', 'TN28BM9403', 'RVP/05/26-27', 30, 50.50],
  ['2026-04-13', 'Chhaya Industries', 'KA56-8383', 'RVP/07/26-27', 35, 51.25],
  ['2026-04-14', 'Chhaya Industries', 'TN28BF7423', 'RVP/08/26-27', 25, 50.50],
  ['2026-04-16', 'Srinivasa Agro', 'TN52Q2882', 'RVP/09/26-27', 30, 50.50],
  ['2026-04-17', 'Vimal Industries', 'AP04TU0561', 'RVP/10/26-27', 25, 53.25],
  ['2026-05-05', 'Enegix', 'TN28BF7423', 'RVP/13/26-27', 25, 51.00],
  ['2026-05-06', 'Enegix', 'TN28BF7498', 'RVP/14/26-27', 25, 51.00],
  ['2026-05-07', 'Enegix', 'TN29DX2661', 'RVP/15/26-27', 30, 51.00],
  ['2026-05-08', 'Enegix - Soham Agro', 'TN52AB3633', 'RVP/16/26-27', 30, 51.00],
  ['2026-05-09', 'Enegix - Soham Agro', 'TN52M7456', 'RVP/17/26-27', 30, 51.00],
  ['2026-05-10', 'Enegix - Soham Agro', 'TN52AD8526', 'RVP/19/26-27', 35, 51.00],
  ['2026-05-10', 'Enegix', 'AP03TE9651', 'RVP/20/26-27', 25, 51.00],
  ['2026-05-12', 'Soham Agro', 'TN28BM9403', 'RVP/22/26-27', 35, 52.00],
  ['2026-05-13', 'Soham Agro', 'TN52AF8868', 'RVP/23/26-27', 35, 52.00],
  ['2026-05-13', 'Colourtex', 'AP04TU0561', 'RVP/24/26-27', 25, 51.50],
  ['2026-05-15', 'Enegix', 'KA09D1455', 'RVP/26/26-27', 30, 52.00],
  ['2026-05-16', 'Enegix', 'TN90H8199', 'RVP/28/26-27', 30, 52.00],
  ['2026-05-17', 'Colourtex', 'TN52P5108', 'RVP/29/26-27', 30, 52.00],
  ['2026-05-18', 'Soham Agro', 'TN52AF4353', 'RVP/31/26-27', 35, 52.00],
  ['2026-05-19', 'Spectrum', 'AP03TJ0150', 'RVP/32/26-27', 25, 51.50],
  ['2026-05-19', 'Colourtex', 'TN83E2399', 'RVP/34/26-27', 30, 52.00],
  ['2026-05-20', 'Soham Agro', 'TN52AE6064', 'RVP/35/26-27', 35, 52.00],
  ['2026-05-21', 'Spectrum', 'TN28BF7498', 'RVP/36/26-27', 25, 51.50],
  ['2026-05-25', 'Adinath', 'TN28BF7423', 'RVP/39/26-27', 25, 49.50],
  ['2026-05-27', 'Soham Agro', 'TN52AB1937', 'RVP/40/26-27', 30, 50.50],
  ['2026-05-30', 'Colourtex', 'TN90H8199', 'RVP/41/26-27', 30, 52.00],
  ['2026-05-30', 'Colourtex', 'AP39U7475', 'RVP/42/26-27', 25, 51.50],
  ['2026-05-30', 'Chhaya Industries', 'TN28BF7498', 'RVP/43/26-27', 25, 48.50],
  ['2026-05-31', 'Colourtex', 'AP03TE3029', 'RVP/44/26-27', 25, 52.00],
  ['2026-05-31', 'Colourtex', 'AP39WR0129', 'RVP/45/26-27', 35, 52.00],
  ['2026-06-02', 'Colourtex', 'TN52M4755', 'RVP/48/26-27', 35, 52.00],
  ['2026-06-02', 'Chhaya Industries', 'AP03TE7209', 'RVP/49/26-27', 30, 48.50],
  ['2026-06-02', 'Spectrum', 'TN29CJ5779', 'RVP/50/26-27', 35, 49.50],
  ['2026-06-03', 'Chhaya Industries', 'TN29CC9492', 'RVP/51/26-27', 30, 48.50],
  ['2026-06-04', 'Chhaya Industries', 'TN36AK7378', 'RVP/53/26-27', 30, 48.50],
  ['2026-06-05', 'Colourtex', 'TN52J9102', 'RVP/54/26-27', 30, 49.50],
  ['2026-06-07', 'Colourtex', 'TN34AZ5349', 'RVP/56/26-27', 30, 49.50],
  ['2026-06-09', 'Colourtex', 'TN86A6588', 'RVP/58/26-27', 30, 49.50],
  ['2026-06-11', 'Colourtex', 'TN52P0705', 'RVP/60/26-27', 30, 49.50],
  ['2026-06-12', 'Chhaya Industries', 'TN52K5931', 'RVP/61/26-27', 30, 47.50],
  ['2026-06-13', 'Colourtex', 'AP39UF5999', 'RVP/62/26-27', 30, 49.50],
  ['2026-06-26', 'Soham Agro', 'TN28BF7498', 'RVP/68/26-27', 25, 49.00],
  ['2026-06-26', 'Soham Agro', 'TN28BF7423', 'RVP/69/26-27', 25, 49.00],
  ['2026-06-27', 'Soham Agro', '', 'RVP/71/26-27', 35, 49.00],
];

// Parse "RVP/01/26-27" → { invoiceSeq: 1, invoiceFy: "2026-27", invoiceNumber: "RVP/01/26-27" }
function parseInvoice(inv: string) {
  const parts = inv.split('/');
  const seq = parseInt(parts[1], 10);
  const fyShort = parts[2]; // "26-27"
  const invoiceFy = '20' + fyShort; // "2026-27"
  return { invoiceSeq: seq, invoiceFy, invoiceNumber: inv };
}

async function main() {
  // Upsert all unique buyer parties
  const partyMap = new Map<string, string>();
  const uniqueBuyers = [...new Set(ROWS.map(([, name]) => name))];

  for (const name of uniqueBuyers) {
    const existing = await prisma.party.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    });
    let id: string;
    if (existing) {
      // Ensure party can act as buyer
      if (existing.type === 'SUPPLIER') {
        await prisma.party.update({ where: { id: existing.id }, data: { type: 'BOTH' } });
      }
      id = existing.id;
    } else {
      const created = await prisma.party.create({ data: { name, type: 'BUYER' } });
      id = created.id;
    }
    partyMap.set(name.toLowerCase(), id);
  }

  let created = 0;

  for (const [dateStr, buyerName, lorryNo, invoiceStr, netTonnes, pricePerKg] of ROWS) {
    const buyerId = partyMap.get(buyerName.toLowerCase())!;
    const weightKg = Math.round(netTonnes * 1000);
    const saleDate = new Date(dateStr);
    const { invoiceSeq, invoiceFy, invoiceNumber } = parseInvoice(invoiceStr);
    const vehicleNumber = lorryNo.trim() || null;

    // One SaleOrder per lorry (already dispatched)
    const order = await prisma.saleOrder.create({
      data: {
        saleDate,
        product: 'PAPPU',
        buyerId,
        tonnageKg: weightKg,
        ratePerKg: pricePerKg,
        gstAmount: 0,
        brokerageRatePerKg: 0,
        freightCharge: 0,
        status: 'DISPATCHED',
        invoiceNumber,
        vehicleNumber,
        invoiceSeq,
        invoiceFy,
        invoiceDate: saleDate,
      },
    });

    // One SaleDispatch for the lorry
    await prisma.saleDispatch.create({
      data: {
        saleOrderId: order.id,
        dispatchDate: saleDate,
        weightKg,
        vehicleNumber,
        status: 'DISPATCHED',
        invoiceNumber,
        invoiceSeq,
        invoiceFy,
        invoiceDate: saleDate,
        gstAmount: 0,
        freightCharge: 0,
      },
    });

    console.log(`[${created + 1}] ${dateStr} | ${buyerName} | ${lorryNo || '-'} | ${invoiceStr} | ${netTonnes}t @ ₹${pricePerKg}/kg`);
    created++;
  }

  console.log(`\nDone. ${created} sale records imported.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
