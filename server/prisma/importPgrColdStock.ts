import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ── PGR Cold black-seed stock (additive) ──────────────────────────────────────
// Loads seed that landed directly at the PGR COLD storage. Each row becomes a
// full Party → PurchaseOrder → StockIn → Purchase → WeightVerification chain with
// loadingLocation = 'PGR COLD', and rolls the seed into the BLACK_SEED silo at
// 'PGR COLD'. That makes it show up on Stock by Location (PGR COLD price bands),
// as available stock on the Stock Transfer tiles, and everywhere else that reads
// verified purchases (Purchases, Purchase Statement, Stock by Party, etc.).
//
// This script is ADDITIVE - it does NOT clear any data. It refuses to run twice
// (guards on the PGRC- PO prefix) so stock can't be double-counted.
//
// Tuple: [isoDate (YYYY-MM-DD), party, lorryNumber, invoiceNumber, tons, pricePerKg]
const DATA: [string, string, string, string, number, number][] = [
  ['2026-03-28', 'KTV Karimangalam', 'AP39UQ4204', '216', 14.06, 27.70],
  ['2026-05-23', 'Bismillah Traders', 'TN52C3595', '', 30.2, 27.90],
  ['2026-05-23', 'Malola Narasimha Traders', 'TN30AC1466', '', 19.35, 28.00],
  ['2026-05-23', 'Malola Narasimha Traders', 'TN48AD7504', '', 25.73, 28.00],
  ['2026-05-23', 'KAS Traders', 'TN23DF1899', '', 27.29, 27.20],
  ['2026-05-24', 'DCS', 'TN29CW6941', '', 25.09, 28.00],
  ['2026-05-24', 'ZAHEER NARTHAM (BA Traders)', 'TN28BF7423', '', 23.57, 27.50],
  ['2026-05-24', 'SVS Mariyamman Traders', 'TN23CB3742', '', 25, 27.50],
  ['2026-05-26', 'CRS', 'TN88AY1150', '', 28.84, 27.50],
  ['2026-05-28', 'DCS', 'TN52AF0939', '', 29.11, 27.50],
  ['2026-05-29', 'Raghu Sira (NPK Traders)', 'KA06AB9225', '', 19.11, 28.00],
  ['2026-05-29', 'DCS', 'TN28BC7399', '', 27.56, 27.50],
  ['2026-05-30', 'Malola Narasimha Traders', 'TN68T7261', '', 33.77, 27.50],
  ['2026-05-31', 'Malola Narasimha Traders', 'TN21BH0712', '', 31.74, 27.50],
  ['2026-06-01', 'DCS', 'TN30CW1599', '', 28.98, 27.50],
];

const LOCATION = 'PGR COLD';
const PO_PREFIX = 'PGRC';

async function main() {
  // Idempotency guard: bail out if this batch was already imported.
  const already = await prisma.purchaseOrder.count({
    where: { poNumber: { startsWith: `${PO_PREFIX}-` } },
  });
  if (already > 0) {
    console.error(
      `✗ Aborting: ${already} '${PO_PREFIX}-' purchase order(s) already exist - PGR Cold stock looks imported.\n` +
      `  Delete those POs first (and their PGR COLD silo balance) if you need to re-import.`
    );
    process.exit(1);
  }

  // Resolve parties (case-insensitive dedup by name), creating any missing.
  const partyCache = new Map<string, string>(); // UPPER(name) → id
  const existing = await prisma.party.findMany({ select: { id: true, name: true } });
  for (const p of existing) partyCache.set(p.name.trim().toUpperCase(), p.id);

  async function partyId(name: string): Promise<string> {
    const key = name.trim().toUpperCase();
    const hit = partyCache.get(key);
    if (hit) return hit;
    const created = await prisma.party.create({
      data: { name: name.trim(), type: 'SUPPLIER' },
      select: { id: true },
    });
    partyCache.set(key, created.id);
    return created.id;
  }

  console.log(`Importing ${DATA.length} PGR Cold purchase rows…`);
  let n = 0;
  const createdParties: string[] = [];
  const beforeParties = partyCache.size;

  for (const [iso, party, lorry, invoice, tons, price] of DATA) {
    const weightKg = Math.round(tons * 1000);
    const date = new Date(`${iso}T00:00:00.000Z`);
    const before = partyCache.size;
    const pid = await partyId(party);
    if (partyCache.size > before) createdParties.push(party);

    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber: `${PO_PREFIX}-${String(++n).padStart(3, '0')}`,
        poDate: date,
        partyId: pid,
        pricePerKg: price,
        priceType: 'DELIVERY',
        tonnageKg: weightKg,
        actualTonnageKg: weightKg,
        status: 'COMPLETED',
        createdBy: 'pgr-cold-import',
      },
    });

    const stockIn = await prisma.stockIn.create({
      data: {
        purchaseOrderId: po.id,
        arrivalDate: date,
        lorryNumber: lorry,
        invoiceNumber: invoice,
        rvpFirstWeightKg: 0,
        rvpSecondWeightKg: 0,
        rvpKataKg: weightKg,
        billingWeightKg: weightKg,
        partyKataKg: weightKg,
        invoiceFileUrl: '',
        loadingLocation: LOCATION,
      },
    });

    const purchase = await prisma.purchase.create({
      data: {
        stockInId: stockIn.id,
        netWeightKg: weightKg,
        hamaliCharge: 0,
        freightCharge: 0,
      },
    });

    await prisma.weightVerification.create({
      data: {
        purchaseId: purchase.id,
        billingWeightKg: weightKg,
        partyKataKg: weightKg,
        rvpKataKg: weightKg,
        referenceKg: weightKg,
        diffKg: 0,
        exempt: true,
        finalWeightKg: weightKg,
        pricePerKg: price,
        totalAmount: weightKg * price * 1.05,
      },
    });

    // Roll into the BLACK_SEED silo at PGR COLD (valued ex-GST at base price), so
    // the Stock Transfer page shows it as available to move to the process.
    const silo = await prisma.siloInventory.findFirst({
      where: { itemType: 'BLACK_SEED', location: LOCATION },
    });
    const addedCost = weightKg * price;
    if (silo) {
      await prisma.siloInventory.update({
        where: { id: silo.id },
        data: {
          weightKg: silo.weightKg + weightKg,
          totalValue: Number(silo.totalValue) + addedCost,
        },
      });
    } else {
      await prisma.siloInventory.create({
        data: { itemType: 'BLACK_SEED', location: LOCATION, weightKg, totalValue: addedCost },
      });
    }
  }

  // Summary.
  const totalKg = DATA.reduce((s, r) => s + Math.round(r[4] * 1000), 0);
  const totalValue = DATA.reduce((s, r) => s + Math.round(r[4] * 1000) * r[5], 0);
  const bands = new Set(DATA.map((r) => r[5].toFixed(2)));
  console.log('✓ PGR Cold import complete.');
  console.log(`  Rows:          ${DATA.length}`);
  console.log(`  New parties:   ${partyCache.size - beforeParties}${createdParties.length ? ` (${createdParties.join(', ')})` : ''}`);
  console.log(`  Price bands:   ${bands.size} (${[...bands].sort().join(', ')})`);
  console.log(`  Black seed:    ${(totalKg / 1000).toFixed(2)} MT at ${LOCATION}`);
  console.log(`  Valuation:     ₹${totalValue.toLocaleString('en-IN')} (ex-GST)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
