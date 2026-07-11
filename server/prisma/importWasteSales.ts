import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Tamarind Waste sales register → Tamarind Byproducts › Tamarind Waste tab.
// One SaleOrder + SaleDispatch per lorry (already dispatched), mirroring
// importSalesData.ts. No invoice numbers were recorded for these loads.
// [date, buyerName, lorryNo, netTonnes, pricePerKg]
type Row = [string, string, string, number, number];

// Record 1 had only an amount (₹28,000) and no rate → 28000 / 1340 kg = ₹20.90/kg.
const ROWS: Row[] = [
  ['2026-04-08', 'Babayya',    'AP03TC9744', 1.34, 20.90],
  ['2026-05-15', 'Ali - Jinna', 'AP39UC6507', 3.26, 24.00],
  ['2026-06-04', 'Babayya',    'AP03TC9744', 2.07, 22.50],
];

async function main() {
  // Upsert all unique buyer parties, tagging them as Tamarind Waste buyers.
  const partyMap = new Map<string, string>();
  const uniqueBuyers = [...new Set(ROWS.map(([, name]) => name))];

  for (const name of uniqueBuyers) {
    const existing = await prisma.party.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    });
    let id: string;
    if (existing) {
      const commodities = [...new Set([...existing.commodities, 'TAMARIND_WASTE' as const])];
      await prisma.party.update({
        where: { id: existing.id },
        data: {
          type: existing.type === 'SUPPLIER' ? 'BOTH' : existing.type,
          commodities,
        },
      });
      id = existing.id;
    } else {
      const created = await prisma.party.create({
        data: { name, type: 'BUYER', commodities: ['TAMARIND_WASTE'] },
      });
      id = created.id;
    }
    partyMap.set(name.toLowerCase(), id);
  }

  let created = 0;

  for (const [dateStr, buyerName, lorryNo, netTonnes, pricePerKg] of ROWS) {
    const buyerId = partyMap.get(buyerName.toLowerCase())!;
    const weightKg = Math.round(netTonnes * 1000);
    const saleDate = new Date(dateStr);
    const vehicleNumber = lorryNo.trim() || null;

    // One SaleOrder per lorry (already dispatched)
    const order = await prisma.saleOrder.create({
      data: {
        saleDate,
        product: 'WASTE',
        buyerId,
        tonnageKg: weightKg,
        ratePerKg: pricePerKg,
        gstAmount: 0,
        brokerageRatePerKg: 0,
        freightCharge: 0,
        status: 'DISPATCHED',
        vehicleNumber,
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
        gstAmount: 0,
        freightCharge: 0,
      },
    });

    console.log(`[${created + 1}] ${dateStr} | ${buyerName} | ${lorryNo} | ${netTonnes}t @ ₹${pricePerKg}/kg = ₹${Math.round(weightKg * pricePerKg).toLocaleString('en-IN')}`);
    created++;
  }

  console.log(`\nDone. ${created} tamarind waste sale records imported.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
