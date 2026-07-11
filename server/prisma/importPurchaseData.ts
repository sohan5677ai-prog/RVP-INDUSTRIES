import 'dotenv/config';
import { PrismaClient, PriceType, POStatus } from '@prisma/client';

const prisma = new PrismaClient();

// [date, partyName, lorryNumber, netTonnes, pricePerKg]
type Row = [string, string, string, number, number];

const ROWS: Row[] = [
  ['2026-03-31', 'Kallur Kadervalli', 'AP39UX9105', 10.22, 27.67],
  ['2026-04-01', 'Siddiq V Kota', 'AP39UP5880', 5.53, 27.75],
  ['2026-04-02', 'Kannan Katpadi', 'TN23AR7921', 10.94, 28.50],
  ['2026-04-03', 'DCS', 'AP04TU0561', 25.22, 27.87],
  ['2026-04-04', 'Sri Rajalakshmi Stores', 'TN36AP9599', 35.65, 28.00],
  ['2026-04-05', 'Fayaz V Kota', 'AP39UX9105', 9.20, 27.00],
  ['2026-04-07', 'Kannan Katpadi', 'TN23AR7921', 11.45, 27.75],
  ['2026-04-07', 'KTV Karimangalam', 'AP39UX9108', 15.37, 27.00],
  ['2026-04-07', 'KTV Karimangalam', 'AP39UX9105', 15.84, 27.00],
  ['2026-04-07', 'Vijayalakshmi Trading Co', 'AP03TA4905', 13.25, 28.25],
  ['2026-04-08', 'Raghu Sira (NPK Traders)', 'KA06AB9225', 19.91, 28.91],
  ['2026-04-08', 'HMS Traders', 'KA01AG1566', 30.22, 27.65],
  ['2026-04-08', 'Siddiq V Kota', 'AP03TF1004', 5.68, 28.00],
  ['2026-04-10', 'NPK Traders', 'KA16AA4733', 36.11, 28.91],
  ['2026-04-10', 'DCS', 'TN52M9266', 30.16, 28.00],
  ['2026-04-10', 'KMK Traders', 'TN23CE6361', 25.47, 28.35],
  ['2026-04-11', 'Arul Dindivanam', 'TN36AP9599', 41.62, 28.50],
  ['2026-04-11', 'Malola Narasimha Traders', 'AP39UK7788', 14.99, 28.00],
  ['2026-04-11', 'DCS', 'TN33BQ9096', 26.76, 28.25],
  ['2026-04-11', 'Karthik Traders', 'TN52H6998', 21.05, 28.00],
  ['2026-04-11', 'Johar', 'KA07B0989', 2.75, 28.50],
  ['2026-04-11', 'Vijay Katpadi', 'TN23DJ6394', 3.58, 28.50],
  ['2026-04-12', 'Malola Narasimha Traders', 'TN24AY1521', 19.16, 28.00],
  ['2026-04-12', 'Karthik Traders', 'TN52-4070', 19.06, 28.00],
  ['2026-04-12', 'Siddhi Vinayaka Traders', 'KA40B2565', 15.07, 28.50],
  ['2026-04-13', 'Kallur Kadervalli', 'AP39UX9108', 16.92, 28.50],
  ['2026-04-13', 'Sri Vinayaga Traders - Dinakaran', 'TN68T7261', 30.15, 29.25],
  ['2026-04-13', 'DCS', 'TN52AB1778', 30.02, 28.90],
  ['2026-04-13', 'Murali Marnalli', 'AP03TE3162', 16.34, 29.25],
  ['2026-04-13', 'Siddiq V Kota', 'AP39UP5880', 5.21, 28.25],
  ['2026-04-14', 'Kalyandurgam Maruti', 'AP03X7830', 21.18, 29.30],
  ['2026-04-14', 'KTV Karimangalam', 'AP39UX9105', 15.99, 28.00],
  ['2026-04-14', 'Kata Senthil', 'TN52AA8475', 27.18, 28.75],
  ['2026-04-14', 'Sri Rajalakshmi Stores', 'TN23DD5499', 36.98, 28.95],
  ['2026-04-14', 'Raghu Sira (NPK Traders)', 'KA16AA4734', 38.65, 28.91],
  ['2026-04-15', 'KTV Karimangalam', 'AP03TE3029', 26.98, 28.00],
  ['2026-04-15', 'HMS Traders', 'AP02TC6894', 30.09, 27.65],
  ['2026-04-16', 'Pragati Traders', 'AP04TW3356', 30.09, 28.36],
  ['2026-04-16', 'Siddiq V Kota', 'AP39UP5880', 4.37, 29.50],
  ['2026-04-17', 'Sadiq Anchetty', 'TN524070', 21.07, 28.80],
  ['2026-04-18', 'DCS', 'TN52H1564', 25.46, 29.10],
  ['2026-04-18', 'DCS', 'AP21TY8770', 28.56, 30.25],
  ['2026-04-18', 'Bismillah Enterprises', 'TN39CH9840', 24.89, 29.30],
  ['2026-04-18', 'Raghu Sira (NPK Traders)', 'KA16AA0338', 35.54, 31.75],
  ['2026-04-18', 'Malola Narasimha Traders', 'TN28P7697', 19.81, 30.45],
  ['2026-04-18', 'Raghu Sira (NPK Traders)', 'KA16AA4735', 35.65, 31.50],
  ['2026-04-19', 'Bismillah Enterprises', 'KA01AN1514', 25.01, 29.50],
  ['2026-04-19', 'Baburao', 'AP21TZ7677', 25.05, 30.99],
  ['2026-04-19', 'Siddiq V Kota', 'AP39U0723', 4.30, 28.25],
  ['2026-04-20', 'Kamaraj Marthandam', 'TN74AY7996', 16.98, 29.00],
  ['2026-05-01', 'Sultan', 'AP03TC3631', 2.10, 28.50],
  ['2026-05-04', 'Siddiq V Kota', 'AP39U0723', 2.70, 28.00],
  ['2026-05-05', 'Babavali Kutagula', 'AP39TF7218', 1.90, 27.50],
  ['2026-05-05', 'Raghu Sira (NPK Traders)', 'KA06AB9225', 20.17, 28.75],
  ['2026-05-05', 'DCS', 'TN52J8465', 27.53, 28.40],
  ['2026-05-07', 'Siddiq V Kota', 'AP39U0723', 3.31, 27.75],
  ['2026-05-07', 'Bismillah Enterprises', 'TN24S6757', 29.14, 28.50],
  ['2026-05-07', 'Bismillah Enterprises', 'TN29BS5214', 27.27, 28.50],
  ['2026-05-08', 'Raghu Sira (NPK Traders)', 'KA06AB9225', 19.19, 28.75],
  ['2026-05-08', 'DCS', 'TN36AT3060', 25.06, 28.10],
  ['2026-05-09', 'DCS', 'TN48AT8535', 25.49, 28.10],
  ['2026-05-09', 'Kallur Kadervalli', 'AP39UX9108', 12.44, 27.50],
  ['2026-05-09', 'DCS', 'TN52S0174', 26.66, 28.00],
  ['2026-05-10', 'Bismillah Enterprises', 'TN29AV6138', 32.56, 28.00],
  ['2026-05-10', 'KNT', 'KA671897', 1.15, 28.50],
  ['2026-05-11', 'Arul Dindivanam', 'TN36AP9599', 32.69, 28.00],
  ['2026-05-11', 'Malola Narasimha Traders', 'TN29BJ0223', 25.26, 28.25],
  ['2026-05-11', 'Bismillah Enterprises', 'AP39VE9927', 34.17, 28.00],
  ['2026-05-11', 'Karthik Traders', 'TN24AC4168', 24.04, 28.25],
  ['2026-05-11', 'Karthik Traders', 'TN52L9378', 23.98, 28.25],
  ['2026-05-12', 'KTV Karimangalam', 'AP39UX9105', 15.59, 27.00],
  ['2026-05-12', 'DCS', 'TN52P4512', 32.20, 28.00],
  ['2026-05-12', 'Anandham Kovilapatti', 'TN24AM9947', 29.69, 28.75],
  ['2026-05-13', 'DCS', 'TN28AL8449', 26.48, 28.00],
  ['2026-05-13', 'Karthik Traders', 'TN524070', 22.90, 28.25],
  ['2026-05-14', 'KMK Traders', 'TN23DJ9567', 29.70, 29.50],
  ['2026-05-14', 'Malola Narasimha Traders', 'TN48AD7504', 26.38, 28.25],
  ['2026-05-15', 'DCS', 'TN29BS2534', 29.17, 28.00],
  ['2026-05-15', 'KTV Karimangalam', 'AP39UX9108', 15.00, 28.20],
  ['2026-05-15', 'KTV Karimangalam', 'AP39UX9105', 15.02, 28.20],
  ['2026-05-15', 'MMS', 'KL06B6824', 1.20, 28.00],
  ['2026-05-15', 'Sri Vinayaga Traders - Dinakaran', 'TN23DH0459', 34.48, 28.00],
  ['2026-05-16', 'Siddiq V Kota', 'AP39UP5880', 5.01, 27.75],
  ['2026-05-16', 'Bismillah Enterprises', 'AP39VE0027', 29.34, 28.00],
  ['2026-05-16', 'Malola Narasimha Traders', 'TN52F7351', 24.30, 28.00],
  ['2026-05-16', 'DCS', 'TN52S0174', 27.24, 28.00],
  ['2026-05-16', 'Karthik Traders', 'TN28BA4946', 30.56, 28.40],
  ['2026-05-16', 'Malola Narasimha Traders', 'TN23BT5069', 20.17, 28.00],
  ['2026-05-17', 'Mahesh Trading', 'TN52J0936', 25.56, 27.75],
  ['2026-05-17', 'Mithun Agencies', 'TN29BB5748', 24.61, 27.80],
  ['2026-05-17', 'AB Traders', 'TN30BS7326', 24.21, 28.75],
  ['2026-05-17', 'Murali Marnalli', 'TN29BB4836', 23.85, 27.00],
  ['2026-05-18', 'Bismillah Traders', 'TN34AB1535', 36.19, 28.00],
  ['2026-05-18', 'Malola Narasimha Traders', 'TN47S0146', 18.52, 28.00],
  ['2026-05-18', 'Kannan Katpadi', 'TN23AR7921', 11.56, 27.50],
  ['2026-05-18', 'CRS', 'TN52J8944', 25.20, 28.00],
  ['2026-05-19', 'Raghu Sira (NPK Traders)', 'KA06AB9225', 19.45, 28.00],
  ['2026-05-20', 'Bismillah Traders', 'TN29CK7000', 24.80, 28.00],
  ['2026-05-20', 'Murugan and Co', 'TN52Q0257', 23.94, 28.00],
  ['2026-05-21', 'DCS', 'TN52J0969', 24.54, 28.00],
  ['2026-05-21', 'Malola Narasimha Traders', 'TN91T3799', 32.93, 28.00],
  ['2026-05-22', 'DCS', 'AP39UN9679', 29.71, 28.00],
  ['2026-05-24', 'Baba MTC', 'AP39WL9039', 3.54, 27.00],
  ['2026-05-25', 'Suresh Katpadi', 'AP39WC7563', 2.19, 27.00],
  ['2026-05-25', 'Baba MTC', 'AP39WL9039', 1.60, 27.50],
  ['2026-05-27', 'Kallur Kadervalli', 'AP39WQ0271', 4.89, 27.50],
  ['2026-06-02', 'Siddiq V Kota', 'AP39UP5880', 5.57, 26.50],
  ['2026-06-04', 'Siddiq V Kota', 'AP39UP5880', 5.68, 26.00],
  ['2026-06-04', 'Karthikeyan Pallipattu', 'AP21TE1224', 23.61, 26.50],
  ['2026-06-05', 'Nandeesh Chintamani', 'TN28BF7423', 20.39, 27.00],
  ['2026-06-06', 'DCS', 'TN48AT8535', 25.30, 26.75],
  ['2026-06-07', 'DCS', 'TN39CH9840', 25.10, 26.75],
  ['2026-06-08', 'Malola Narasimha Traders', 'TN88L5684', 26.76, 27.50],
  ['2026-06-09', 'Kannan Katpadi', 'TN23AR7921', 12.10, 26.25],
  ['2026-06-09', 'KMK Traders', 'TN30BK5877', 30.50, 28.00],
  ['2026-06-10', 'DCS', 'TN34V6133', 26.18, 26.50],
  ['2026-06-11', 'Mithun Agencies', 'TN52H2154', 27.87, 26.25],
  ['2026-06-12', 'DCS', 'TN52J8944', 25.30, 26.40],
  ['2026-06-12', 'Malola Narasimha Traders', 'TN24AY1521', 19.01, 26.50],
  ['2026-06-13', 'Malola Narasimha Traders', 'TN91T3799', 33.87, 26.50],
  ['2026-06-13', 'Baburao', 'AP03TA0075', 19.91, 28.50],
  ['2026-06-13', 'Malola Narasimha Traders', 'TN23DM2728', 32.50, 27.50],
  ['2026-06-14', 'Senthil Papparpatty', 'TN28BF7423', 28.25, 25.20],
  ['2026-06-14', 'Murali Marnalli', 'TN28BF7423', 0.92, 25.20],
  ['2026-06-16', 'Velichamy', 'TN28BF7498', 26.13, 26.25],
  ['2026-06-16', 'Yallammadevi Enterprises', 'AP02TE5758', 30.41, 28.30],
  ['2026-06-17', 'AB Traders', 'KA06AA0980', 14.06, 28.00],
  ['2026-06-18', 'DCS', 'TN34W3799', 33.39, 26.40],
  ['2026-06-19', 'KTV Karimangalam', 'AP39UX9105', 14.68, 26.30],
  ['2026-06-21', 'Marthandam', 'AP39UX9108', 15.72, 26.00],
  ['2026-06-22', 'Marthandam', 'AP39UX9105', 14.59, 26.00],
  ['2026-06-23', 'DCS', 'TN30BU7477', 25.90, 26.00],
  ['2026-06-23', 'Murali Marnalli', 'AP03T9630', 10.27, 26.25],
  ['2026-06-25', 'Anandham Kovilapatti', 'TN34X4475', 34.47, 26.90],
];

function calcHamali(netKg: number, rate = 150): number {
  return Math.round(netKg / 1000) * rate;
}

function calcKataFee(netKg: number): number {
  const tonnes = netKg / 1000;
  if (tonnes <= 15) return 50;
  if (tonnes <= 25) return 150;
  return 200;
}

async function main() {
  const admin = await prisma.user.findFirst({ where: { username: 'admin' } });
  if (!admin) throw new Error('Admin user not found - run seed first');

  // Upsert all unique parties (case-insensitive dedup)
  const partyMap = new Map<string, string>(); // normalised name → id
  const uniqueNames = [...new Set(ROWS.map(([, name]) => name))];

  for (const name of uniqueNames) {
    const existing = await prisma.party.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    });
    let id: string;
    if (existing) {
      id = existing.id;
    } else {
      const created = await prisma.party.create({
        data: { name, type: 'SUPPLIER' },
      });
      id = created.id;
    }
    partyMap.set(name.toLowerCase(), id);
  }

  let seq = 1;
  let created = 0;

  for (const [dateStr, partyName, lorryNumber, netTonnes, pricePerKg] of ROWS) {
    const partyId = partyMap.get(partyName.toLowerCase())!;
    const netKg = Math.round(netTonnes * 1000);
    const poNumber = `IMP-${seq.toString().padStart(3, '0')}`;
    const invoiceNumber = `IMP-${seq.toString().padStart(3, '0')}`;
    const arrivalDate = new Date(dateStr);

    const hamaliCharge = calcHamali(netKg);
    const kataFee = calcKataFee(netKg);

    // One PO per lorry, already arrived
    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber,
        poDate: arrivalDate,
        partyId,
        pricePerKg,
        priceType: 'DELIVERY',
        tonnageKg: netKg,
        actualTonnageKg: netKg,
        lorryCount: 1,
        status: 'ARRIVED',
        createdBy: admin.id,
      },
    });

    const stockIn = await prisma.stockIn.create({
      data: {
        purchaseOrderId: po.id,
        arrivalDate,
        lorryNumber,
        invoiceNumber,
        rvpFirstWeightKg: netKg,
        rvpSecondWeightKg: 0,
        rvpKataKg: netKg,
        billingWeightKg: netKg,
        partyKataKg: netKg,
        invoiceFileUrl: '',
        loadingLocation: 'At process',
        freightCharge: 0,
      },
    });

    await prisma.purchase.create({
      data: {
        stockInId: stockIn.id,
        netWeightKg: netKg,
        hamaliRate: 150,
        hamaliCharge,
        kataFee,
        freightCharge: 0,
      },
    });

    console.log(`[${seq}] ${dateStr} | ${partyName} | ${lorryNumber} | ${netTonnes}t | ₹${pricePerKg}/kg | hamali ₹${hamaliCharge} | kata ₹${kataFee}`);
    seq++;
    created++;
  }

  console.log(`\nDone. ${created} records imported.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
