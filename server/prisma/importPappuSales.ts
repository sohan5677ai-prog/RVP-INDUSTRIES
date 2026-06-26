import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ── PAPPU sales from "TEST DATA.xlsx" (rows 2-45) ─────────────────────────────
// Tuple: [dateStr, buyer, lorryNumber, invoice, pappuTons, pappuPricePerKg]
// Each row is a PAPPU sale. 
const SALES: [string, string, string, string, number, number][] = [
  ['06-04-2026', 'Chhaya Industries', 'TN28BF7423', 'RVP/01/26-27', 25, 48.20],
  ['08-04-2026', 'Adinath', 'TN28BF7498', 'RVP/03/26-27', 25, 48.70],
  ['10-04-2026', 'Adinath', 'TN30AM0299', 'RVP/04/26-27', 25, 48.70],
  ['12-04-2026', 'Srinivasa Agro', 'TN28BM9403', 'RVP/05/26-27', 30, 49.00],
  ['13-04-2026', 'Chhaya Industries', 'KA56-8383', 'RVP/07/26-27', 35, 49.45],
  ['14-04-2026', 'Chhaya Industries', 'TN28BF7423', 'RVP/08/26-27', 25, 48.70],
  ['16-04-2026', 'Srinivasa Agro', 'TN52Q2882', 'RVP/09/26-27', 30, 49.00],
  ['17-04-2026', 'Vimal Industries', 'AP04TU0561', 'RVP/10/26-27', 25, 50.55],
  ['05-05-2026', 'Enegix', 'TN28BF7423', 'RVP/13/26-27', 25, 48.30],
  ['06-05-2026', 'Enegix', 'TN28BF7498', 'RVP/14/26-27', 25, 48.30],
  ['07-05-2026', 'Enegix', 'TN29DX2661', 'RVP/15/26-27', 30, 48.30],
  ['08-05-2026', 'Enegix - Soham Agro', 'TN52AB3633', 'RVP/16/26-27', 30, 48.30],
  ['09-05-2026', 'Enegix - Soham Agro', 'TN52M7456', 'RVP/17/26-27', 30, 48.30],
  ['10-05-2026', 'Enegix - Soham Agro', 'TN52AD8526', 'RVP/19/26-27', 35, 48.30],
  ['10-05-2026', 'Enegix', 'AP03TE9651', 'RVP/20/26-27', 25, 48.30],
  ['12-05-2026', 'Soham Agro', 'TN28BM9403', 'RVP/22/26-27', 35, 49.30],
  ['13-05-2026', 'Soham Agro', 'TN52AF8868', 'RVP/23/26-27', 35, 49.30],
  ['13-05-2026', 'Colourtex', 'AP04TU0561', 'RVP/24/26-27', 25, 48.80],
  ['15-05-2026', 'Enegix', 'KA09D1455', 'RVP/26/26-27', 30, 49.30],
  ['16-05-2026', 'Enegix', 'TN90H8199', 'RVP/28/26-27', 30, 49.30],
  ['17-05-2026', 'Colourtex', 'TN52P5108', 'RVP/29/26-27', 30, 49.30],
  ['18-05-2026', 'Soham Agro', 'TN52AF4353', 'RVP/31/26-27', 35, 49.30],
  ['19-05-2026', 'Spectrum', 'AP03TJ0150', 'RVP/32/26-27', 25, 48.80],
  ['19-05-2026', 'Colourtex', 'TN83E2399', 'RVP/34/26-27', 30, 49.30],
  ['20-05-2026', 'Soham Agro', 'TN52AE6064', 'RVP/35/26-27', 35, 49.30],
  ['21-05-2026', 'Spectrum', 'TN28BF7498', 'RVP/36/26-27', 25, 48.80],
  ['25-05-2026', 'Adinath', 'TN28BF7423', 'RVP/39/26-27', 25, 47.50],
  ['27-05-2026', 'Soham Agro', 'TN52AB1937', 'RVP/40/26-27', 30, 47.80],
  ['30-05-2026', 'Colourtex', 'TN90H8199', 'RVP/41/26-27', 30, 49.30],
  ['30-05-2026', 'Colourtex', 'AP39U7475', 'RVP/42/26-27', 25, 48.80],
  ['30-05-2026', 'Chhaya Industries', 'TN28BF7498', 'RVP/43/26-27', 25, 46.70],
  ['31-05-2026', 'Colourtex', 'AP03TE3029', 'RVP/44/26-27', 25, 49.30],
  ['31-05-2026', 'Colourtex', 'AP39WR0129', 'RVP/45/26-27', 35, 49.30],
  ['02-06-2026', 'Colourtex', 'TN52M4755', 'RVP/48/26-27', 35, 49.30],
  ['02-06-2026', 'Chhaya Industries', 'AP03TE7209', 'RVP/49/26-27', 30, 46.70],
  ['02-06-2026', 'Spectrum', 'TN29CJ5779', 'RVP/50/26-27', 35, 46.80],
  ['03-06-2026', 'Chhaya Industries', 'TN29CC9492', 'RVP/51/26-27', 30, 46.70],
  ['04-06-2026', 'Chhaya Industries', 'TN36AK7378', 'RVP/53/26-27', 30, 46.70],
  ['05-06-2026', 'Colourtex', 'TN52J9102', 'RVP/54/26-27', 30, 46.80],
  ['07-06-2026', 'Colourtex', 'TN34AZ5349', 'RVP/56/26-27', 30, 46.80],
  ['09-06-2026', 'Colourtex', 'TN86A6588', 'RVP/58/26-27', 30, 46.80],
  ['11-06-2026', 'Colourtex', 'TN52P0705', 'RVP/60/26-27', 30, 46.80],
  ['12-06-2026', 'Chhaya Industries', 'TN52K5931', 'RVP/61/26-27', 30, 45.70],
  ['13-06-2026', 'Colourtex', 'AP39UF5999', 'RVP/62/26-27', 30, 46.80],
];

function parseDateStr(dateStr: string): Date {
  const [day, month, year] = dateStr.split('-');
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

async function main() {
  // 1) Clear existing sales so the import is idempotent (purchases untouched).
  console.log('Clearing existing sales…');
  await prisma.saleDispatch.deleteMany();
  await prisma.saleOrder.deleteMany();

  // 2) Resolve buyer parties (case-insensitive dedup), creating any missing.
  const partyCache = new Map<string, string>();
  const existing = await prisma.party.findMany({ select: { id: true, name: true } });
  for (const p of existing) partyCache.set(p.name.trim().toUpperCase(), p.id);

  async function buyerId(name: string): Promise<string> {
    const key = name.trim().toUpperCase();
    const hit = partyCache.get(key);
    if (hit) return hit;
    const created = await prisma.party.create({
      data: { name: name.trim(), type: 'BUYER' },
      select: { id: true },
    });
    partyCache.set(key, created.id);
    return created.id;
  }

  // 3) One PAPPU SaleOrder + SaleDispatch per row.
  console.log(`Importing ${SALES.length} pappu sales…`);
  let buyers = 0;
  const before = partyCache.size;
  for (const [dateStr, buyer, lorry, invoice, tons, price] of SALES) {
    const weightKg = Math.round(tons * 1000);
    const date = parseDateStr(dateStr);
    const bid = await buyerId(buyer);

    const order = await prisma.saleOrder.create({
      data: {
        saleDate: date,
        product: 'PAPPU',
        buyerId: bid,
        tonnageKg: weightKg,
        ratePerKg: price,
        status: 'DISPATCHED',
      },
    });
    await prisma.saleDispatch.create({
      data: {
        saleOrderId: order.id,
        weightKg,
        dispatchDate: date,
        vehicleNumber: lorry,
        invoiceNumber: invoice,
      },
    });
  }
  buyers = partyCache.size - before;

  // 4) Summary.
  const totalKg = SALES.reduce((s, r) => s + Math.round(r[4] * 1000), 0);
  console.log('✓ Pappu sales imported.');
  console.log(`  Sales:        ${SALES.length}`);
  console.log(`  New buyers:   ${buyers}`);
  console.log(`  Pappu sold:   ${(totalKg / 1000).toFixed(2)} MT`);
  console.log(`  Black seed consumed @60%: ${((totalKg / 0.6) / 1000).toFixed(2)} MT`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());

