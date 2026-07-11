import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { LedgerService } from '../src/services/ledger.service.js';

const prisma = new PrismaClient();

// ── Murugan Cold Storage agri loans (UBI) ─────────────────────────────────────
// Loads the storage-loan drawdowns funding the stock held at Murugan Cold Storage.
// Each row is one UBI "Agri Loan" account: it becomes a BankLoan at location
// 'Murugan', bank 'UBI', name 'Agri Loan', with the bank account number stored as
// the loan/account reference (loanRef). Every drawdown is posted to the GL exactly
// like the Add Loan flow (Dr Bank/Cash / Cr Bank Loan Payable), so the Bank Loans
// page, Stock by Location "Outstanding Loans" tile and Balance Sheet all agree.
//
// This script is ADDITIVE and idempotent - it skips any account number already
// loaded (guards on loanRef), so it is safe to re-run.
//
// Tuple: [accountRef (UBI A/c ID), personName, principal (₹)]
const DATA: [string, string, number][] = [
  ['668306030000299', 'G KESAVAREDDY', 1500008.16],
  ['668306030000300', 'S KRISHNA MURTHY', 1500010.38],
  ['668306030000301', 'S SUBRAMANYAM', 1500000.0],
  ['668306030000302', 'H PRANEETH KUMAR', 1500000.0],
  ['668306030000303', 'P R SATHYA SREE', 1500000.0],
  ['668306030000304', 'P S GURU PRASAD', 1500000.0],
  ['668306030000305', 'PAVAN KUMAR S', 1500010.38],
  ['668306030000306', 'G RAMAKRISHNA', 1500000.0],
  ['668306030000307', 'P VASEEM BASHA', 1500000.0],
  ['668306030000308', 'G RADHA', 1500000.0],
  ['668306030000309', 'RATNESH SINGH', 1500000.0],
  ['668306030000310', 'N RANGANATHA NAIDU', 1500000.0],
  ['668306030000311', 'G RAJENDRA', 1500000.0],
  ['668306030000312', 'POOJARI KRISHNAPPA', 1500000.0],
  ['668306030000313', 'P VENKATESH', 1500000.0],
  ['668306030000314', 'B SREENIVASULU', 1500000.0],
  ['668306030000315', 'B AHMED ALI', 1500000.0],
  ['668306030000316', 'PANCHANGAM R JASWANTH', 1500000.0],
  ['668306030000317', 'GUNDLURI VASANTHA SARATHY', 1500000.0],
  ['668306030000318', 'KONDAVITI NARENDRA', 1500000.0],
  ['668306030000319', 'K.MAHA LAKSHMI', 1500000.0],
  ['668306030000320', 'P SHAKUNTALA', 1500000.0],
  ['668306030000321', 'C VASANTHA KUMARI', 1500000.0],
  ['668306030000322', 'M MANI KUMAR', 1500000.0],
  ['668306030000323', 'T VENKATARAMANA', 1500000.0],
  ['668306030000324', 'P SHANKARA', 1500000.0],
  ['668306030000325', 'TUPAKULA SARASWATHI', 1500000.0],
  ['668306030000326', 'KOTHURU AMRUTHA VANI', 1500000.0],
  ['668306030000327', 'Y KARUNAKAR', 1500000.0],
  ['668306030000328', 'S JILANEE BASHA', 1500000.0],
  ['668306030000329', 'P RAJENDRA SASTRY', 1500000.0],
  ['668306030000330', 'PUJARI PAPULAMMA', 1500000.0],
  ['668306030000331', 'ONTELA SADIQ BASHA', 1500000.0],
  ['668306030000332', 'G GOUSIYA', 1500000.0],
  ['668306030000333', 'T SAI KUMAR', 1500000.0],
  ['668306030000334', 'KAPADAM SUNIL YADAV', 1500000.0],
  ['668306030000335', 'V MALLIKARJUNA RAO', 1500000.0],
  ['668306030000336', 'R CHALAPATHI', 1500000.0],
  ['668306030000337', 'N MUNI VENKATA SIVA KUMAR', 1500000.0],
  ['668306030000338', 'E RAJENDRAN', 1500000.0],
  ['668306030000339', 'AYAZ GAFOOR ABBAS SHAIK', 1300000.0],
];

const LOCATION = 'Murugan';
const BANK = 'UBI';
const LOAN_NAME = 'Agri Loan';
// UBI agri loan rate is 0.8% per MONTH. The interest engine stores an ANNUAL
// rate (value × rate/100 × days/365), so persist the annual equivalent.
const MONTHLY_RATE_PCT = 0.8;
const INTEREST_RATE_PCT = Math.round(MONTHLY_RATE_PCT * 12 * 1000) / 1000; // 9.6% p.a.
const DRAWDOWN_DATE = new Date('2026-03-15T00:00:00.000Z');

async function main() {
  const rate = INTEREST_RATE_PCT;

  console.log(`Importing ${DATA.length} Murugan Cold Storage (${BANK}) agri loans…`);

  let created = 0;
  let skipped = 0;
  for (const [ref, personName, principal] of DATA) {
    const already = await prisma.bankLoan.findFirst({ where: { loanRef: ref } });
    if (already) {
      skipped++;
      continue;
    }

    await prisma.$transaction(async (tx) => {
      const loan = await tx.bankLoan.create({
        data: {
          name: LOAN_NAME,
          personName,
          loanRef: ref,
          bankName: BANK,
          location: LOCATION,
          principal,
          drawdownDate: DRAWDOWN_DATE,
          interestRatePct: rate,
        },
      });
      await LedgerService.postLoanDrawdown(tx, loan.id, {
        date: DRAWDOWN_DATE,
        amount: principal,
        bankName: BANK,
        loanRef: ref,
      });
    });
    created++;
  }

  const totalPrincipal = DATA.reduce((s, r) => s + r[2], 0);
  console.log('✓ Murugan loan import complete.');
  console.log(`  Created:        ${created}`);
  console.log(`  Skipped (dup):  ${skipped}`);
  console.log(`  Location:       ${LOCATION}`);
  console.log(`  Bank / type:    ${BANK} · ${LOAN_NAME}`);
  console.log(`  Interest rate:  ${MONTHLY_RATE_PCT}% / month (${rate}% / yr)`);
  console.log(`  Total principal: ₹${totalPrincipal.toLocaleString('en-IN')}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
