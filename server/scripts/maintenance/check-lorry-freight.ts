import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Actual lorry freights from the transporter's confirmation sheet.
const ACTUAL: { lorry: string; date: string; to: string; tonnes: number; freight: number }[] = [
  { lorry: 'GJ04AX6555', date: '2026-08-01', to: 'Surat', tonnes: 30, freight: 80000 },
  { lorry: 'AP05TG4959', date: '2026-08-01', to: 'Surat', tonnes: 30, freight: 80000 },
  { lorry: 'GJ04AW7409', date: '2026-07-29', to: 'Surat', tonnes: 30, freight: 80000 },
  { lorry: 'TN34AZ5349', date: '2026-07-27', to: 'Surat', tonnes: 30, freight: 80000 },
  { lorry: 'TN86F2242', date: '2026-07-28', to: 'Surat', tonnes: 30, freight: 80000 },
  { lorry: 'TN52M4755', date: '2026-07-19', to: 'Selvassa', tonnes: 30, freight: 80000 },
  { lorry: 'TN52P5108', date: '2026-07-21', to: 'Selvassa', tonnes: 30, freight: 80000 },
  { lorry: 'AP39T8217', date: '2026-07-18', to: 'Surat', tonnes: 30, freight: 80000 },
  { lorry: 'AP39VF0066', date: '2026-07-19', to: 'Selvassa', tonnes: 30, freight: 80000 },
  { lorry: 'GJ03BV5571', date: '2026-08-03', to: 'Surat', tonnes: 30, freight: 80000 },
  { lorry: 'TN28BM9403', date: '2026-07-01', to: 'Surat', tonnes: 30, freight: 80000 },
  { lorry: 'GJ06AX4056', date: '2026-06-29', to: 'Surat', tonnes: 30, freight: 80000 },
  { lorry: 'TN52AC2251', date: '2026-06-27', to: 'Shahada', tonnes: 35, freight: 84000 },
  { lorry: 'TN52AH1074', date: '2026-07-31', to: 'Surat', tonnes: 35, freight: 92000 },
  { lorry: 'AP39UF5999', date: '2026-06-13', to: 'Surat', tonnes: 30, freight: 80000 },
  { lorry: 'TN52P0705', date: '2026-06-11', to: 'Surat', tonnes: 30, freight: 80000 },
  { lorry: 'TN86A6588', date: '2026-08-02', to: 'Surat', tonnes: 30, freight: 80000 },
  { lorry: 'TN52J9102', date: '2026-06-05', to: 'Surat', tonnes: 30, freight: 80000 },
  { lorry: 'TN90H8199', date: '2026-05-30', to: 'Surat', tonnes: 30, freight: 78000 },
  { lorry: 'TN52M0483', date: '2026-05-22', to: 'Surat', tonnes: 30, freight: 76000 },
  { lorry: 'TN52AE6064', date: '2026-05-20', to: 'Shahada', tonnes: 35, freight: 80500 },
  { lorry: 'TN83E2399', date: '2026-05-20', to: 'Surat', tonnes: 30, freight: 73000 },
  { lorry: 'TN52AF4353', date: '2026-05-17', to: 'Shahada', tonnes: 35, freight: 80500 },
];

const norm = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function run() {
  const dispatches = await prisma.saleDispatch.findMany({
    where: { vehicleNumber: { not: null } },
    select: {
      id: true,
      vehicleNumber: true,
      dispatchDate: true,
      weightKg: true,
      freightCharge: true,
      transportProvider: true,
      saleOrder: {
        select: {
          id: true,
          product: true,
          destination: true,
          freightRatePerTonne: true,
          priceType: true,
          costFrozenAt: true,
          buyer: { select: { name: true, destination: true } },
        },
      },
    },
    orderBy: { dispatchDate: 'asc' },
  });

  const byLorry = new Map<string, typeof dispatches>();
  for (const d of dispatches) {
    const k = norm(d.vehicleNumber);
    if (!byLorry.has(k)) byLorry.set(k, [] as unknown as typeof dispatches);
    byLorry.get(k)!.push(d);
  }

  console.log(`Total dispatches with a vehicle number: ${dispatches.length}`);
  console.log('');
  console.log(
    ['LORRY', 'SHEET_DT', 'ERP_DT', 'PRODUCT', 'BUYER', 'DEST', 'WT_KG', 'ERP_FRT', 'ACTUAL_FRT', 'DIFF', 'FROZEN'].join(' | '),
  );

  let matched = 0;
  const missing: string[] = [];
  for (const a of ACTUAL) {
    const hits = byLorry.get(norm(a.lorry)) ?? [];
    if (hits.length === 0) {
      missing.push(`${a.lorry} (${a.date}, ${a.to})`);
      continue;
    }
    for (const d of hits) {
      matched++;
      const erp = Number(d.freightCharge);
      console.log(
        [
          a.lorry,
          a.date,
          d.dispatchDate.toISOString().slice(0, 10),
          d.saleOrder.product,
          d.saleOrder.buyer.name,
          d.saleOrder.destination ?? d.saleOrder.buyer.destination ?? '-',
          d.weightKg,
          erp.toFixed(2),
          a.freight.toFixed(2),
          (a.freight - erp).toFixed(2),
          d.saleOrder.costFrozenAt ? 'Y' : 'N',
        ].join(' | '),
      );
    }
  }

  console.log('');
  console.log(`Matched rows: ${matched}`);
  console.log(`Sheet lorries with NO dispatch in ERP (${missing.length}):`);
  for (const m of missing) console.log('  - ' + m);

  // Any PAPPU dispatch in the sheet's date window that is NOT on the sheet
  const sheetSet = new Set(ACTUAL.map((a) => norm(a.lorry)));
  const from = new Date('2026-05-01');
  const to = new Date('2026-08-31');
  const extras = dispatches.filter(
    (d) => d.dispatchDate >= from && d.dispatchDate <= to && !sheetSet.has(norm(d.vehicleNumber)),
  );
  console.log('');
  console.log(`Dispatches in 1-May..31-Aug-26 NOT on the sheet (${extras.length}):`);
  for (const d of extras) {
    console.log(
      `  - ${d.vehicleNumber} | ${d.dispatchDate.toISOString().slice(0, 10)} | ${d.saleOrder.product} | ${d.saleOrder.buyer.name} | ${d.weightKg}kg | frt ${Number(d.freightCharge).toFixed(2)}`,
    );
  }
}

run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
