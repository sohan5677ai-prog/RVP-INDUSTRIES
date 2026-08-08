/**
 * Backfill: widen every ProductTaxInfo.hsn from the old 4-digit heading to the
 * 6-digit sub-heading.
 *
 * NIC rejects a 4-digit HSN with e-invoice error 2311 ("6 digits HSN code is
 * mandatory for tax payers with AATO greater than or equal to 5 Crores"), so
 * `Gen IRN` failed for every commodity. The classification is unchanged - these
 * are the sub-headings under the same headings, so the GST rate stays 5%.
 *
 * New installs already get these from PRODUCT_TAX_DEFAULTS in
 * settings.controller.ts; this only fixes databases created before that.
 *
 *   npx tsx scripts/fix-hsn-6-digit.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const HSN: Record<string, string> = {
  PAPPU: '120799',
  TPS: '120799',
  HUSK: '140490',
  SHELL: '140490',
  WASTE: '230800',
  PRECLEANER_DUST: '230800',
  NALLA_POKKULU: '230800',
  NALLA_CHINTAPANDU: '230800',
};

async function main() {
  for (const [product, hsn] of Object.entries(HSN)) {
    const r = await prisma.productTaxInfo.updateMany({ where: { product }, data: { hsn } });
    console.log(`${product} -> ${hsn} (rows updated: ${r.count})`);
  }

  console.log('--- after ---');
  for (const r of await prisma.productTaxInfo.findMany({ orderBy: { product: 'asc' } })) {
    console.log(`${r.product}\thsn=${r.hsn}\thsnExempt=${r.hsnExempt ?? '-'}\tgst=${r.gstRate}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
