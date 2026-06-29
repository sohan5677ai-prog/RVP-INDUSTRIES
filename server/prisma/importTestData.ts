import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ── Data extracted from "TEST DATA.xlsx" ──────────────────────────────────────
// Tuple: [excelSerialDate, party, lorryNumber, tons, pricePerKg]
// Tonnage is in metric tonnes; location is "At process" for every row.
const DATA: [number, string, string, number, number][] = [
  [46112, 'Kallur Kadervalli', 'AP39UX9105', 10.22, 27.67],
  [46113, 'Siddiq V kota', 'AP39UP5880', 5.53, 27.75],
  [46114, 'Kannan Katpadi', 'TN23AR7921', 10.94, 28.5],
  [46115, 'DCS', 'AP04TU0561', 25.22, 27.87],
  [46116, 'Sri Rajalakshmi Stores', 'TN36AP9599', 35.65, 28],
  [46117, 'Fayaz V Kota', 'AP39UX9105', 9.2, 27],
  [46119, 'Kannan Katpadi', 'TN23AR7921', 11.45, 27.75],
  [46119, 'KTV Karimangalam', 'AP39UX9108', 15.37, 27],
  [46119, 'KTV Karimangalam', 'AP39UX9105', 15.84, 27],
  [46119, 'Vijayalakshmi Trading Co', 'AP03TA4905', 13.25, 28.25],
  [46120, 'Raghu Sira (NPK Traders)', 'KA06AB9225', 19.91, 28.91],
  [46120, 'HMS Traders', 'KA01AG1566', 30.22, 27.65],
  [46120, 'Siddiq V kota', 'AP03TF1004', 5.68, 28],
  [46122, 'NPK TRADERS', 'KA16AA4733', 36.11, 28.91],
  [46122, 'DCS', 'TN52M9266', 30.16, 28],
  [46122, 'KMK Traders', 'TN23CE6361', 25.47, 28.35],
  [46123, 'Arul Dindivanam', 'TN36AP9599', 41.62, 28.5],
  [46123, 'Malola Narasimha Traders', 'AP39UK7788', 14.99, 28],
  [46123, 'DCS', 'TN33BQ9096', 26.76, 28.25],
  [46123, 'Karthik Traders', 'TN52H6998', 21.05, 28],
  [46123, 'Johar', 'KA07B0989', 2.75, 28.5],
  [46123, 'Vijay Katpadi', 'TN23DJ6394', 3.58, 28.5],
  [46124, 'Malola Narasimha Traders', 'TN24AY1521', 19.16, 28],
  [46124, 'Karthik Traders', 'TN52-4070', 19.06, 28],
  [46124, 'SIDDHI VINAYAKA TRADERS', 'KA40B2565', 15.07, 28.5],
  [46125, 'Kallur Kadervalli', 'AP39UX9108', 16.92, 28.5],
  [46125, 'Sri Vinayaga Traders - Dinakaran', 'TN68T7261', 30.15, 29.25],
  [46125, 'DCS', 'TN52AB1778', 30.02, 28.9],
  [46125, 'Murali Marnalli', 'AP03TE3162', 16.34, 29.25],
  [46125, 'Siddiq V kota', 'AP39UP5880', 5.21, 28.25],
  [46126, 'Kalyandurgam Maruti', 'AP03X7830', 21.18, 29.3],
  [46126, 'KTV Karimangalam', 'AP39UX9105', 15.99, 28],
  [46126, 'Kata Senthil', 'TN52AA8475', 27.18, 28.75],
  [46126, 'SRI RAJALAKSHMI STORES', 'TN23DD5499', 36.98, 28.95],
  [46126, 'Raghu Sira (NPK Traders)', 'KA16AA4734', 38.65, 28.91],
  [46127, 'KTV Karimangalam', 'AP03TE3029', 26.98, 28],
  [46127, 'HMS Traders', 'AP02TC6894', 30.09, 27.65],
  [46128, 'Pragati Traders', 'AP04TW3356', 30.09, 28.36],
  [46128, 'Siddiq V kota', 'AP39UP5880', 4.37, 29.5],
  [46129, 'Sadiq Anchetty', 'TN524070', 21.07, 28.8],
  [46130, 'DCS', 'TN52H1564', 25.46, 29.1],
  [46130, 'DCS', 'AP21TY8770', 28.56, 30.25],
  [46130, 'Bismillah Enterprises', 'TN39CH9840', 24.89, 29.3],
  [46130, 'Raghu Sira (NPK Traders)', 'KA16AA0338', 35.54, 31.75],
  [46130, 'Malola Narasimha Traders', 'TN28P7697', 19.81, 30.45],
  [46130, 'Raghu Sira (NPK Traders)', 'KA16AA4735', 35.65, 31.5],
  [46131, 'Bismillah Enterprises', 'KA01AN1514', 25.01, 29.5],
  [46131, 'Baburao', 'AP21TZ7677', 25.05, 30.99],
  [46131, 'SIDDIQ V KOTA', 'AP39U0723', 4.3, 28.25],
  [46132, 'Kamaraj Marthandam', 'TN74AY7996', 16.98, 29],
  [46143, 'Sultan', 'AP03TC3631', 2.1, 28.5],
  [46146, 'Siddiq V kota', 'AP39U0723', 2.7, 28],
  [46147, 'Babavali Kutagula', 'AP39TF7218', 1.9, 27.5],
  [46147, 'Raghu Sira (NPK Traders)', 'KA06AB9225', 20.17, 28.75],
  [46147, 'DCS', 'TN52J8465', 27.53, 28.4],
  [46149, 'Siddiq V kota', 'AP39U0723', 3.31, 27.75],
  [46149, 'Bismillah Enterprises', 'TN24S6757', 29.14, 28.5],
  [46149, 'Bismillah Enterprises', 'TN29BS5214', 27.27, 28.5],
  [46150, 'Raghu Sira (NPK Traders)', 'KA06AB9225', 19.19, 28.75],
  [46150, 'DCS', 'TN36AT3060', 25.06, 28.1],
  [46151, 'DCS', 'TN48AT8535', 25.49, 28.1],
  [46151, 'Kallur Kadervalli', 'AP39UX9108', 12.44, 27.5],
  [46151, 'DCS', 'TN52S0174', 26.66, 28],
  [46152, 'Bismillah Enterprises', 'TN29AV6138', 32.56, 28],
  [46152, 'KNT', 'KA671897', 1.15, 28.5],
  [46153, 'Arul Dindivanam', 'TN36AP9599', 32.69, 28],
  [46153, 'Malola Narasimha Traders', 'TN29BJ0223', 25.26, 28.25],
  [46153, 'Bismillah Enterprises', 'AP39VE9927', 34.17, 28],
  [46153, 'Karthik Traders', 'TN24AC4168', 24.04, 28.25],
  [46153, 'Karthik Traders', 'TN52L9378', 23.98, 28.25],
  [46154, 'KTV Karimangalam', 'AP39UX9105', 15.59, 27],
  [46154, 'DCS', 'TN52P4512', 32.2, 28],
  [46154, 'Anandham Kovilapatti', 'TN24AM9947', 29.69, 28.75],
  [46155, 'DCS', 'TN28AL8449', 26.48, 28],
  [46155, 'Karthik Traders', 'TN524070', 22.9, 28.25],
  [46156, 'KMK Traders', 'TN23DJ9567', 29.7, 29.5],
  [46156, 'Malola Narasimha Traders', 'TN48AD7504', 26.38, 28.25],
  [46157, 'DCS', 'TN29BS2534', 29.17, 28],
  [46157, 'KTV Karimangalam', 'AP39UX9108', 15, 28.2],
  [46157, 'KTV Karimangalam', 'AP39UX9105', 15.02, 28.2],
  [46157, 'MMS', 'KL06B6824', 1.2, 28],
  [46157, 'Sri Vinayaga Traders - Dinakaran', 'TN23DH0459', 34.48, 28],
  [46158, 'Siddiq V kota', 'AP39UP5880', 5.01, 27.75],
  [46158, 'Bismillah Enterprises', 'AP39VE0027', 29.34, 28],
  [46158, 'Malola Narasimha Traders', 'TN52F7351', 24.3, 28],
  [46158, 'DCS', 'TN52S0174', 27.24, 28],
  [46158, 'Karthik Traders', 'TN28BA4946', 30.56, 28.4],
  [46158, 'Malola Narasimha Traders', 'TN23BT5069', 20.17, 28],
  [46159, 'Mahesh Trading', 'TN52J0936', 25.56, 27.75],
  [46159, 'Mithun Agencies', 'TN29BB5748', 24.61, 27.8],
  [46159, 'AB Traders', 'TN30BS7326', 24.21, 28.75],
  [46159, 'Murali Marnalli', 'TN29BB4836', 23.85, 27],
  [46160, 'Bismillah Traders', 'TN34AB1535', 36.19, 28],
  [46160, 'Malola Narasimha Traders', 'TN47S0146', 18.52, 28],
  [46160, 'Kannan Katpadi', 'TN23AR7921', 11.56, 27.5],
  [46160, 'CRS', 'TN52J8944', 25.2, 28],
  [46161, 'Raghu Sira (NPK Traders)', 'KA06AB9225', 19.45, 28],
  [46162, 'Bismillah Traders', 'TN29CK7000', 24.8, 28],
  [46162, 'Murugan and Co', 'TN52Q0257', 23.94, 28],
  [46163, 'DCS', 'TN52J0969', 24.54, 28],
  [46163, 'Malola Narasimha Traders', 'TN91T3799', 32.93, 28],
  [46164, 'DCS', 'AP39UN9679', 29.71, 28],
  [46166, 'Baba MTC', 'AP39WL9039', 3.54, 27],
  [46167, 'Suresh Katpadi', 'AP39WC7563', 2.19, 27],
  [46167, 'Baba MTC', 'AP39WL9039', 1.6, 27.5],
  [46169, 'Kallur Kadervalli', 'AP39WQ0271', 4.89, 27.5],
  [46175, 'Siddiq V kota', 'AP39UP5880', 5.57, 26.5],
  [46177, 'Siddiq V kota', 'AP39UP5880', 5.68, 26],
  [46177, 'Karthikeyan Pallipattu', 'AP21TE1224', 23.61, 26.5],
  [46178, 'Nandeesh Chintamani', 'TN28BF7423', 20.39, 27],
  [46179, 'DCS', 'TN48AT8535', 25.3, 26.75],
  [46180, 'DCS', 'TN39CH9840', 25.1, 26.75],
  [46181, 'Malola Narasimha Traders', 'TN88L5684', 26.76, 27.5],
  [46182, 'Kannan Katpadi', 'TN23AR7921', 12.1, 26.25],
  [46182, 'KMK Traders', 'TN30BK5877', 30.5, 28],
  [46183, 'DCS', 'TN34V6133', 26.18, 26.5],
  [46184, 'Mithun Agencies', 'TN52H2154', 27.87, 26.25],
  [46185, 'DCS', 'TN52J8944', 25.3, 26.4],
  [46185, 'Malola Narasimha Traders', 'TN24AY1521', 19.01, 26.5],
  [46186, 'Malola Narasimha Traders', 'TN91T3799', 33.87, 26.5],
  [46186, 'Baburao', 'AP03TA0075', 19.91, 28.5],
  [46186, 'Malola Narasimha Traders', 'TN23DM2728', 32.5, 27.5],
  [46187, 'Senthil Papparpatty', 'TN28BF7423', 28.25, 25.2],
  [46187, 'Murali Marnalli', 'TN28BF7423', 0.92, 25.2],
  [46189, 'Velichamy', 'TN28BF7498', 26.13, 26.25],
  [46189, 'Yallammadevi Enterprises', 'AP02TE5758', 30.41, 28.3],
  [46190, 'AB Traders', 'KA06AA0980', 14.06, 28],
  [46191, 'DCS', 'TN34W3799', 33.39, 26.4],
  [46192, 'KTV Karimangalam', 'AP39UX9105', 14.68, 25.5],
];

/** Excel serial date → JS Date (Excel epoch is 1899-12-30, accounts for 1900 bug). */
function excelDate(serial: number): Date {
  return new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
}

async function main() {
  // 1) Clear existing transactional data (same FK-safe order as the system reset).
  console.log('Clearing existing transactional data…');
  await prisma.$transaction([
    prisma.processing.deleteMany(),
    prisma.weightVerification.deleteMany(),
    prisma.purchase.deleteMany(),
    prisma.stockIn.deleteMany(),
    prisma.stockTransfer.deleteMany(),
    prisma.purchaseOrder.deleteMany(),
    prisma.saleDispatch.deleteMany(),
    prisma.saleOrder.deleteMany(),
    prisma.journalLine.deleteMany(),
    prisma.journalEntry.deleteMany(),
    prisma.siloInventory.deleteMany(),
  ]);

  // 2) Resolve parties (case-insensitive dedup by name), creating any missing.
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

  // 3) One Party → PurchaseOrder → StockIn → Purchase chain per row, all at process.
  console.log(`Importing ${DATA.length} purchase rows…`);
  let n = 0;
  for (const [serial, party, lorry, tons, price] of DATA) {
    const weightKg = Math.round(tons * 1000);
    const date = excelDate(serial);
    const pid = await partyId(party);

    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber: `TEST-${String(++n).padStart(3, '0')}`,
        poDate: date,
        partyId: pid,
        pricePerKg: price,
        priceType: 'DELIVERY',
        tonnageKg: weightKg,
        status: 'PENDING',
        createdBy: 'excel-import',
      },
    });

    const stockIn = await prisma.stockIn.create({
      data: {
        purchaseOrderId: po.id,
        arrivalDate: date,
        lorryNumber: lorry,
        invoiceNumber: '',
        rvpFirstWeightKg: 0,
        rvpSecondWeightKg: 0,
        rvpKataKg: weightKg,
        billingWeightKg: weightKg,
        partyKataKg: weightKg,
        invoiceFileUrl: '',
        loadingLocation: 'At process',
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

    // Update or create SiloInventory record for BLACK_SEED at 'At process'
    const silo = await prisma.siloInventory.findFirst({
      where: { itemType: 'BLACK_SEED', location: 'At process' },
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
        data: {
          itemType: 'BLACK_SEED',
          location: 'At process',
          weightKg,
          totalValue: addedCost,
        },
      });
    }
  }

  // Initialize other raw seed silos for transfer UI compatibility
  const otherLocations = ['Rampalli', 'Murgan', 'Multi'];
  for (const loc of otherLocations) {
    await prisma.siloInventory.create({
      data: {
        itemType: 'BLACK_SEED',
        location: loc,
        weightKg: 0,
        totalValue: 0,
      },
    });
  }

  // 4) Quick summary.
  const totalKg = DATA.reduce((s, r) => s + Math.round(r[3] * 1000), 0);
  const totalValue = DATA.reduce((s, r) => s + Math.round(r[3] * 1000) * r[4], 0);
  const bands = new Set(DATA.map((r) => r[4].toFixed(2)));
  console.log('✓ Import complete.');
  console.log(`  Rows:        ${DATA.length}`);
  console.log(`  Parties:     ${partyCache.size}`);
  console.log(`  Price bands: ${bands.size} (${[...bands].sort().join(', ')})`);
  console.log(`  Black seed:  ${(totalKg / 1000).toFixed(2)} MT`);
  console.log(`  Valuation:   ₹${totalValue.toLocaleString('en-IN')}`);
  console.log(`  Producible pappu @60%: ${((totalKg * 0.6) / 1000).toFixed(2)} MT`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
