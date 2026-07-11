import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ── RVP Black Seed stock ──────────────────────────────────────────────────────
// Tuple: [isoDate (YYYY-MM-DD), party, lorryNumber, tons, pricePerKg]
// Tonnage is in metric tonnes; loading location is "RVP" for every row.
const DATA: [string, string, string, number, number][] = [
  ['2026-03-31', 'Kallur Kadervalli', 'AP39UX9105', 10.22, 27.67],
  ['2026-04-01', 'Siddiq V kota', 'AP39UP5880', 5.53, 27.75],
  ['2026-04-02', 'Kannan Katpadi', 'TN23AR7921', 10.94, 28.5],
  ['2026-04-03', 'DCS', 'AP04TU0561', 25.22, 27.87],
  ['2026-04-04', 'Sri Rajalakshmi Stores', 'TN36AP9599', 35.65, 28],
  ['2026-04-05', 'Fayaz V Kota', 'AP39UX9105', 9.2, 27],
  ['2026-04-07', 'Kannan Katpadi', 'TN23AR7921', 11.45, 27.75],
  ['2026-04-07', 'KTV Karimangalam', 'AP39UX9108', 15.37, 27],
  ['2026-04-07', 'KTV Karimangalam', 'AP39UX9105', 15.84, 27],
  ['2026-04-07', 'Vijayalakshmi Trading Co', 'AP03TA4905', 13.25, 28.25],
  ['2026-04-08', 'Raghu Sira (NPK Traders)', 'KA06AB9225', 19.91, 28.91],
  ['2026-04-08', 'HMS Traders', 'KA01AG1566', 30.22, 27.65],
  ['2026-04-08', 'Siddiq V kota', 'AP03TF1004', 5.68, 28],
  ['2026-04-10', 'NPK TRADERS', 'KA16AA4733', 36.11, 28.91],
  ['2026-04-10', 'DCS', 'TN52M9266', 30.16, 28],
  ['2026-04-10', 'KMK Traders', 'TN23CE6361', 25.47, 28.35],
  ['2026-04-11', 'Arul Dindivanam', 'TN36AP9599', 41.62, 28.5],
  ['2026-04-11', 'Malola Narasimha Traders', 'AP39UK7788', 14.99, 28],
  ['2026-04-11', 'DCS', 'TN33BQ9096', 26.76, 28.25],
  ['2026-04-11', 'Karthik Traders', 'TN52H6998', 21.05, 28],
  ['2026-04-11', 'Johar', 'KA07B0989', 2.75, 28.5],
  ['2026-04-11', 'Vijay Katpadi', 'TN23DJ6394', 3.58, 28.5],
  ['2026-04-12', 'Malola Narasimha Traders', 'TN24AY1521', 19.16, 28],
  ['2026-04-12', 'Karthik Traders', 'TN52-4070', 19.06, 28],
  ['2026-04-12', 'SIDDHI VINAYAKA TRADERS', 'KA40B2565', 15.07, 28.5],
  ['2026-04-13', 'Kallur Kadervalli', 'AP39UX9108', 16.92, 28.5],
  ['2026-04-13', 'Sri Vinayaga Traders - Dinakaran', 'TN68T7261', 30.15, 29.25],
  ['2026-04-13', 'DCS', 'TN52AB1778', 30.02, 28.9],
  ['2026-04-13', 'Murali Marnalli', 'AP03TE3162', 16.34, 29.25],
  ['2026-04-13', 'Siddiq V kota', 'AP39UP5880', 5.21, 28.25],
  ['2026-04-14', 'Kalyandurgam Maruti', 'AP03X7830', 21.18, 29.3],
  ['2026-04-14', 'KTV Karimangalam', 'AP39UX9105', 15.99, 28],
  ['2026-04-14', 'Kata Senthil', 'TN52AA8475', 27.18, 28.75],
  ['2026-04-14', 'SRI RAJALAKSHMI STORES', 'TN23DD5499', 36.98, 28.95],
  ['2026-04-14', 'Raghu Sira (NPK Traders)', 'KA16AA4734', 38.65, 28.91],
  ['2026-04-15', 'KTV Karimangalam', 'AP03TE3029', 26.98, 28],
  ['2026-04-15', 'HMS Traders', 'AP02TC6894', 30.09, 27.65],
  ['2026-04-16', 'Pragati Traders', 'AP04TW3356', 30.09, 28.36],
  ['2026-04-16', 'Siddiq V kota', 'AP39UP5880', 4.37, 29.5],
  ['2026-04-17', 'Sadiq Anchetty', 'TN524070', 21.07, 28.8],
  ['2026-04-18', 'DCS', 'TN52H1564', 25.46, 29.1],
  ['2026-04-18', 'DCS', 'AP21TY8770', 28.56, 30.25],
  ['2026-04-18', 'Bismillah Enterprises', 'TN39CH9840', 24.89, 29.3],
  ['2026-04-18', 'Raghu Sira (NPK Traders)', 'KA16AA0338', 35.54, 31.75],
  ['2026-04-18', 'Malola Narasimha Traders', 'TN28P7697', 19.81, 30.45],
  ['2026-04-18', 'Raghu Sira (NPK Traders)', 'KA16AA4735', 35.65, 31.5],
  ['2026-04-19', 'Bismillah Enterprises', 'KA01AN1514', 25.01, 29.5],
  ['2026-04-19', 'Baburao', 'AP21TZ7677', 25.05, 30.99],
  ['2026-04-19', 'SIDDIQ V KOTA', 'AP39U0723', 4.3, 28.25],
  ['2026-04-20', 'Kamaraj Marthandam', 'TN74AY7996', 16.98, 29],
  ['2026-05-01', 'Sultan', 'AP03TC3631', 2.1, 28.5],
  ['2026-05-04', 'Siddiq V kota', 'AP39U0723', 2.7, 28],
  ['2026-05-05', 'Babavali Kutagula', 'AP39TF7218', 1.9, 27.5],
  ['2026-05-05', 'Raghu Sira (NPK Traders)', 'KA06AB9225', 20.17, 28.75],
  ['2026-05-05', 'DCS', 'TN52J8465', 27.53, 28.4],
  ['2026-05-07', 'Siddiq V kota', 'AP39U0723', 3.31, 27.75],
  ['2026-05-07', 'Bismillah Enterprises', 'TN24S6757', 29.14, 28.5],
  ['2026-05-07', 'Bismillah Enterprises', 'TN29BS5214', 27.27, 28.5],
  ['2026-05-08', 'Raghu Sira (NPK Traders)', 'KA06AB9225', 19.19, 28.75],
  ['2026-05-08', 'DCS', 'TN36AT3060', 25.06, 28.1],
  ['2026-05-09', 'DCS', 'TN48AT8535', 25.49, 28.1],
  ['2026-05-09', 'Kallur Kadervalli', 'AP39UX9108', 12.44, 27.5],
  ['2026-05-09', 'DCS', 'TN52S0174', 26.66, 28],
  ['2026-05-10', 'Bismillah Enterprises', 'TN29AV6138', 32.56, 28],
  ['2026-05-10', 'KNT', 'KA671897', 1.15, 28.5],
  ['2026-05-11', 'Arul Dindivanam', 'TN36AP9599', 32.69, 28],
  ['2026-05-11', 'Malola Narasimha Traders', 'TN29BJ0223', 25.26, 28.25],
  ['2026-05-11', 'Bismillah Enterprises', 'AP39VE9927', 34.17, 28],
  ['2026-05-11', 'Karthik Traders', 'TN24AC4168', 24.04, 28.25],
  ['2026-05-11', 'Karthik Traders', 'TN52L9378', 23.98, 28.25],
  ['2026-05-12', 'KTV Karimangalam', 'AP39UX9105', 15.59, 27],
  ['2026-05-12', 'DCS', 'TN52P4512', 32.2, 28],
  ['2026-05-12', 'Anandham Kovilapatti', 'TN24AM9947', 29.69, 28.75],
  ['2026-05-13', 'DCS', 'TN28AL8449', 26.48, 28],
  ['2026-05-13', 'Karthik Traders', 'TN524070', 22.9, 28.25],
  ['2026-05-14', 'KMK Traders', 'TN23DJ9567', 29.7, 29.5],
  ['2026-05-14', 'Malola Narasimha Traders', 'TN48AD7504', 26.38, 28.25],
  ['2026-05-15', 'DCS', 'TN29BS2534', 29.17, 28],
  ['2026-05-15', 'KTV Karimangalam', 'AP39UX9108', 15, 28.2],
  ['2026-05-15', 'KTV Karimangalam', 'AP39UX9105', 15.02, 28.2],
  ['2026-05-15', 'MMS', 'KL06B6824', 1.2, 28],
  ['2026-05-15', 'Sri Vinayaga Traders - Dinakaran', 'TN23DH0459', 34.48, 28],
  ['2026-05-16', 'Siddiq V kota', 'AP39UP5880', 5.01, 27.75],
  ['2026-05-16', 'Bismillah Enterprises', 'AP39VE0027', 29.34, 28],
  ['2026-05-16', 'Malola Narasimha Traders', 'TN52F7351', 24.3, 28],
  ['2026-05-16', 'DCS', 'TN52S0174', 27.24, 28],
  ['2026-05-16', 'Karthik Traders', 'TN28BA4946', 30.56, 28.4],
  ['2026-05-16', 'Malola Narasimha Traders', 'TN23BT5069', 20.17, 28],
  ['2026-05-17', 'Mahesh Trading', 'TN52J0936', 25.56, 27.75],
  ['2026-05-17', 'Mithun Agencies', 'TN29BB5748', 24.61, 27.8],
  ['2026-05-17', 'AB Traders', 'TN30BS7326', 24.21, 28.75],
  ['2026-05-17', 'Murali Marnalli', 'TN29BB4836', 23.85, 27.5],
  ['2026-05-18', 'Bismillah Traders', 'TN34AB1535', 36.19, 28],
  ['2026-05-18', 'Malola Narasimha Traders', 'TN47S0146', 18.52, 28],
  ['2026-05-18', 'Kannan Katpadi', 'TN23AR7921', 11.56, 27.5],
  ['2026-05-18', 'CRS', 'TN52J8944', 25.2, 28],
  ['2026-05-19', 'Raghu Sira (NPK Traders)', 'KA06AB9225', 19.45, 28],
  ['2026-05-20', 'Bismillah Traders', 'TN29CK7000', 24.8, 28],
  ['2026-05-20', 'Murugan and Co', 'TN52Q0257', 23.94, 28],
  ['2026-05-21', 'DCS', 'TN52J0969', 24.54, 28],
  ['2026-05-21', 'Malola Narasimha Traders', 'TN91T3799', 32.93, 28],
  ['2026-05-22', 'DCS', 'AP39UN9679', 29.71, 28],
  ['2026-05-24', 'Baba MTC', 'AP39WL9039', 3.54, 27],
  ['2026-05-25', 'Suresh Katpadi', 'AP39WC7563', 2.19, 27],
  ['2026-05-25', 'Baba MTC', 'AP39WL9039', 1.6, 27.5],
  ['2026-05-27', 'Kallur Kadervalli', 'AP39WQ0271', 4.89, 27.5],
  ['2026-06-02', 'Siddiq V kota', 'AP39UP5880', 5.57, 26.5],
  ['2026-06-04', 'Siddiq V kota', 'AP39UP5880', 5.68, 26],
  ['2026-06-04', 'Karthikeyan Pallipattu', 'AP21TE1224', 23.61, 26.5],
  ['2026-06-05', 'Nandeesh Chintamani', 'TN28BF7423', 20.39, 27],
  ['2026-06-06', 'DCS', 'TN48AT8535', 25.3, 26.75],
  ['2026-06-07', 'DCS', 'TN39CH9840', 25.1, 26.75],
  ['2026-06-08', 'Malola Narasimha Traders', 'TN88L5684', 26.76, 27.5],
  ['2026-06-09', 'Kannan Katpadi', 'TN23AR7921', 12.1, 26.25],
  ['2026-06-09', 'KMK Traders', 'TN30BK5877', 30.5, 28],
  ['2026-06-10', 'DCS', 'TN34V6133', 26.18, 26.5],
  ['2026-06-11', 'Mithun Agencies', 'TN52H2154', 27.87, 26.25],
  ['2026-06-12', 'DCS', 'TN52J8944', 25.3, 26.4],
  ['2026-06-12', 'Malola Narasimha Traders', 'TN24AY1521', 19.01, 26.5],
  ['2026-06-13', 'Malola Narasimha Traders', 'TN91T3799', 33.87, 26.5],
  ['2026-06-13', 'Baburao', 'AP03TA0075', 19.91, 28.5],
  ['2026-06-13', 'Malola Narasimha Traders', 'TN23DM2728', 32.5, 27.5],
  ['2026-06-14', 'Senthil Papparpatty', 'TN28BF7423', 28.25, 26.8],
  ['2026-06-14', 'Murali Marnalli', 'TN28BF7423', 0.92, 26],
  ['2026-06-16', 'Velichamy', 'TN28BF7498', 26.13, 27.25],
  ['2026-06-16', 'Yallammadevi Enterprises', 'AP02TE5758', 30.41, 28.3],
  ['2026-06-17', 'AB Traders', 'KA06AA0980', 14.06, 28],
  ['2026-06-18', 'DCS', 'TN34W3799', 33.39, 26.4],
  ['2026-06-19', 'KTV Karimangalam', 'AP39UX9105', 14.68, 26.3],
  ['2026-06-21', 'Marthandam', 'AP39UX9108', 15.72, 27],
  ['2026-06-22', 'Marthandam', 'AP39UX9105', 14.59, 27],
  ['2026-06-23', 'DCS', 'TN30BU7477', 25.9, 26],
  ['2026-06-23', 'Murali Marnalli', 'AP03T9630', 10.27, 26.75],
  ['2026-06-25', 'Anandham Kovilapatti', 'TN34X4475', 34.47, 26.9],
  ['2026-06-26', 'KTV Karimangalam', 'AP39UX9108', 13.81, 27.5],
  ['2026-06-28', 'Babayya', 'AP03TC9744', 2.88, 25],
  ['2026-06-29', 'Arul Krishnagiri', 'AP03T9630', 13.67, 27],
  ['2026-06-29', 'KTV Karimangalam', 'AP03X7259', 16.1, 27],
  ['2026-06-30', 'Ramesh Katpadi', 'TN21BJ3070', 31.55, 27.25],
  ['2026-07-01', 'DCS', 'TN28BM9403', 26.22, 26.5],
];

async function main() {
  // 1) Clear existing transactional data (same FK-safe order as the system reset).
  console.log('Clearing existing transactional data…');
  await prisma.$transaction([
    prisma.processing.deleteMany(),
    prisma.weightVerification.deleteMany(),
    prisma.purchase.deleteMany(),
    prisma.stockIn.deleteMany(),
    prisma.stockTransfer.deleteMany(),
    prisma.saleAllocation.deleteMany(),
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

  // 3) One Party → PurchaseOrder → StockIn → Purchase → WeightVerification chain per
  //    row, all delivered to the process (RVP). This is what Black Seed Stock and the
  //    Order Planner (Stock by Price) read from.
  console.log(`Importing ${DATA.length} purchase rows…`);
  let n = 0;
  for (const [iso, party, lorry, tons, price] of DATA) {
    const weightKg = Math.round(tons * 1000);
    const date = new Date(`${iso}T00:00:00.000Z`);
    const pid = await partyId(party);

    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber: `RVP-${String(++n).padStart(3, '0')}`,
        poDate: date,
        partyId: pid,
        pricePerKg: price,
        priceType: 'DELIVERY',
        tonnageKg: weightKg,
        actualTonnageKg: weightKg,
        status: 'COMPLETED',
        createdBy: 'stock-import',
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
        loadingLocation: 'RVP',
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

    // Roll up into the BLACK_SEED silo at 'RVP' (valued ex-GST at base price).
    const silo = await prisma.siloInventory.findFirst({
      where: { itemType: 'BLACK_SEED', location: 'RVP' },
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
          location: 'RVP',
          weightKg,
          totalValue: addedCost,
        },
      });
    }
  }

  // Initialize other raw-seed silos for the Transfer UI compatibility.
  const otherLocations = ['PGR COLD', 'Murugan', 'KNM Multi'];
  for (const loc of otherLocations) {
    await prisma.siloInventory.create({
      data: { itemType: 'BLACK_SEED', location: loc, weightKg: 0, totalValue: 0 },
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
