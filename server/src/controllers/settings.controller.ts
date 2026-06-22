import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';

export async function listFreightRates(_req: Request, res: Response) {
  const rates = await prisma.freightRate.findMany({ orderBy: { destination: 'asc' } });
  res.json(rates);
}

const upsertFreightRatesSchema = z.object({
  rates: z
    .array(
      z.object({
        destination: z.string().min(1),
        ratePerTonne: z.coerce.number().nonnegative(),
      })
    )
    .min(1),
});

/** Upsert all submitted destination rates (edit existing + add new). */
export async function upsertFreightRates(req: Request, res: Response) {
  const { rates } = upsertFreightRatesSchema.parse(req.body);
  await prisma.$transaction(
    rates.map((r) =>
      prisma.freightRate.upsert({
        where: { destination: r.destination.trim() },
        update: { ratePerTonne: r.ratePerTonne },
        create: { destination: r.destination.trim(), ratePerTonne: r.ratePerTonne },
      })
    )
  );
  const updated = await prisma.freightRate.findMany({ orderBy: { destination: 'asc' } });
  res.json(updated);
}

export async function deleteFreightRate(req: Request, res: Response) {
  const rate = await prisma.freightRate.findUnique({ where: { id: req.params.id } });
  if (!rate) throw new HttpError(404, 'Freight rate not found');
  await prisma.freightRate.delete({ where: { id: req.params.id } });
  res.json({ message: 'Freight rate deleted' });
}

/** Look up the ₹/tonne rate for a destination (0 if unknown). */
export async function getFreightRateForDestination(destination: string | null | undefined): Promise<number> {
  if (!destination) return 0;
  const rate = await prisma.freightRate.findUnique({ where: { destination } });
  return rate ? Number(rate.ratePerTonne) : 0;
}

// --- Company profile (single row, lazily created) -------------------------------

const COMPANY_ID = 'default';

/** Fetch the company profile, creating a blank default row on first access. */
export async function getCompanyProfileRow() {
  const existing = await prisma.companyProfile.findUnique({ where: { id: COMPANY_ID } });
  if (existing) return existing;
  return prisma.companyProfile.create({ data: { id: COMPANY_ID } });
}

export async function getCompanyProfile(_req: Request, res: Response) {
  res.json(await getCompanyProfileRow());
}

const companyProfileSchema = z.object({
  name: z.string().trim().min(1),
  address: z.string().optional().nullable(),
  gstin: z.string().optional().nullable(),
  stateName: z.string().optional().nullable(),
  stateCode: z.string().optional().nullable(),
  contact: z.string().optional().nullable(),
  bankAccountName: z.string().optional().nullable(),
  bankName: z.string().optional().nullable(),
  bankAccountNumber: z.string().optional().nullable(),
  bankBranchIfsc: z.string().optional().nullable(),
  invoicePrefix: z.string().trim().min(1).default('RVP'),
  companyVehicles: z.string().optional().nullable(),
  freightRetentionPerTrip: z.coerce.number().nonnegative().optional(),
});

export async function updateCompanyProfile(req: Request, res: Response) {
  const data = companyProfileSchema.parse(req.body);
  const saved = await prisma.companyProfile.upsert({
    where: { id: COMPANY_ID },
    update: data,
    create: { id: COMPANY_ID, ...data },
  });
  res.json(saved);
}

// Invoice print layout (paper/margins/font/column widths) stored as a JSON string.
const invoiceLayoutSchema = z.object({ layout: z.record(z.string(), z.any()) });

export async function updateInvoiceLayout(req: Request, res: Response) {
  const { layout } = invoiceLayoutSchema.parse(req.body);
  await getCompanyProfileRow(); // ensure the row exists
  const saved = await prisma.companyProfile.update({
    where: { id: COMPANY_ID },
    data: { invoiceLayout: JSON.stringify(layout) },
  });
  res.json(saved);
}

// --- Per-product tax info (HSN + invoice description) ---------------------------

const PRODUCTS = ['PAPPU', 'HUSK', 'WASTE', 'TPS', 'SHELL'] as const;
type ProductCode = (typeof PRODUCTS)[number];

const PRODUCT_TAX_DEFAULTS: Record<ProductCode, { hsn: string; description: string }> = {
  PAPPU: { hsn: '1207', description: 'Tamarind Seed Kernel' },
  HUSK: { hsn: '1404', description: 'Tamarind Husk' },
  WASTE: { hsn: '2308', description: 'Tamarind Waste' },
  TPS: { hsn: '1207', description: 'Tamarind Seed Brokens' },
  SHELL: { hsn: '1404', description: 'Tamarind Shell' },
};

/** Return all product tax rows, creating any missing ones with sensible defaults. */
export async function getProductTaxRows() {
  const existing = await prisma.productTaxInfo.findMany();
  const have = new Set(existing.map((r) => r.product));
  const missing = PRODUCTS.filter((p) => !have.has(p));
  if (missing.length) {
    await prisma.productTaxInfo.createMany({
      data: missing.map((p) => ({ product: p, ...PRODUCT_TAX_DEFAULTS[p] })),
    });
  }
  return prisma.productTaxInfo.findMany({ orderBy: { product: 'asc' } });
}

export async function getProductTax(_req: Request, res: Response) {
  res.json(await getProductTaxRows());
}

const productTaxSchema = z.object({
  rows: z
    .array(
      z.object({
        product: z.enum(PRODUCTS),
        hsn: z.string().optional().nullable(),
        hsnExempt: z.string().optional().nullable(),
        description: z.string().optional().nullable(),
      })
    )
    .min(1),
});

export async function updateProductTax(req: Request, res: Response) {
  const { rows } = productTaxSchema.parse(req.body);
  await prisma.$transaction(
    rows.map((r) =>
      prisma.productTaxInfo.upsert({
        where: { product: r.product },
        update: { hsn: r.hsn ?? null, hsnExempt: r.hsnExempt ?? null, description: r.description ?? null },
        create: { product: r.product, hsn: r.hsn ?? null, hsnExempt: r.hsnExempt ?? null, description: r.description ?? null },
      })
    )
  );
  res.json(await prisma.productTaxInfo.findMany({ orderBy: { product: 'asc' } }));
}

// --- Production cost components (per-kg, summed into the pappu cost) -------------

export async function listProductionCostComponents(_req: Request, res: Response) {
  res.json(await prisma.productionCostComponent.findMany({ orderBy: { sortOrder: 'asc' } }));
}

const productionCostSchema = z.object({
  components: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        ratePerKg: z.coerce.number().nonnegative(),
      })
    )
    .default([]),
});

/** Replace-all: the submitted list becomes the full set of components. */
export async function updateProductionCostComponents(req: Request, res: Response) {
  const { components } = productionCostSchema.parse(req.body);
  await prisma.$transaction([
    prisma.productionCostComponent.deleteMany({}),
    ...components.map((c, i) =>
      prisma.productionCostComponent.create({
        data: { name: c.name.trim(), ratePerKg: c.ratePerKg, sortOrder: i },
      })
    ),
  ]);
  res.json(await prisma.productionCostComponent.findMany({ orderBy: { sortOrder: 'asc' } }));
}

/** Total production cost per kg = sum of all component rates. */
export async function getProductionCostPerKg(): Promise<number> {
  const rows = await prisma.productionCostComponent.findMany();
  return Math.round(rows.reduce((sum, r) => sum + Number(r.ratePerKg), 0) * 10000) / 10000;
}
