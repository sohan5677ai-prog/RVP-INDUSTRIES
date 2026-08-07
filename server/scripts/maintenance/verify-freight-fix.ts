import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Every SALE- journal entry must still balance after the freight adjustment,
// and each dispatch's 50050 debit must equal its freightCharge.
async function run() {
  const dispatches = await prisma.saleDispatch.findMany({
    select: { id: true, vehicleNumber: true, dispatchDate: true, freightCharge: true },
  });

  let unbalanced = 0;
  let mismatched = 0;
  let checked = 0;
  for (const d of dispatches) {
    const je = await prisma.journalEntry.findFirst({
      where: { reference: `SALE-${d.id}` },
      include: { lines: { include: { account: true } } },
    });
    if (!je) continue;
    checked++;
    const dr = je.lines.reduce((s, l) => s + Number(l.debit), 0);
    const cr = je.lines.reduce((s, l) => s + Number(l.credit), 0);
    if (Math.abs(dr - cr) > 0.01) {
      unbalanced++;
      console.log(`UNBALANCED ${d.vehicleNumber} ${d.dispatchDate.toISOString().slice(0, 10)}: Dr ${dr} vs Cr ${cr}`);
    }
    const frt = je.lines.find((l) => l.account.code === '50050');
    const dispFrt = Number(d.freightCharge);
    const jeFrt = frt ? Number(frt.debit) : 0;
    if (Math.abs(jeFrt - dispFrt) > 0.01) {
      mismatched++;
      console.log(
        `FREIGHT MISMATCH ${d.vehicleNumber} ${d.dispatchDate.toISOString().slice(0, 10)}: dispatch ${dispFrt} vs 50050 ${jeFrt}`,
      );
    }
  }

  console.log('');
  console.log(`Sale journal entries checked: ${checked}`);
  console.log(`Unbalanced: ${unbalanced}`);
  console.log(`Dispatch freight != 50050 debit: ${mismatched}`);
}

run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
