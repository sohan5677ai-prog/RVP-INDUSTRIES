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

// --- Hamali rates (₹/tonne per operation, drive the live costing) ---------------

export const HAMALI_RATE_KEYS = [
  'BLACK_SEED_UNLOAD',
  'PAPPU_LOADING',
  'TRANSFER_FROM_STORAGE',
  'HUSK_LOADING',
  'TPS_LOADING',
  'SHELL_TRANSFER',
  'WASTE_LOADING',
] as const;
type HamaliRateKey = (typeof HAMALI_RATE_KEYS)[number];

// Seed defaults mirror the current constants in lib/calc.ts so behaviour is
// unchanged until a rate is edited. TRANSFER is the ₹270 load+unload handling
// total (the storage-unload leg is no longer charged).
//   ratePerTonne = full charge; lorry = collected off the driver's freight;
//   margin = company P/L benefit (we collect more from the lorry than we pay the crew).
//   Company-borne share is derived = ratePerTonne − lorry. Crew payable = ratePerTonne − margin.
type HamaliDefault = { label: string; ratePerTonne: number; lorryPerTonne: number; marginPerTonne: number; sortOrder: number };
const HAMALI_RATE_DEFAULTS: Record<HamaliRateKey, HamaliDefault> = {
  BLACK_SEED_UNLOAD: { label: 'Black Seed Unloading', ratePerTonne: 150, lorryPerTonne: 0, marginPerTonne: 0, sortOrder: 0 },
  PAPPU_LOADING: { label: 'Pappu Loading', ratePerTonne: 220, lorryPerTonne: 80, marginPerTonne: 10, sortOrder: 1 },
  TRANSFER_FROM_STORAGE: { label: 'Transfer From Storages', ratePerTonne: 270, lorryPerTonne: 0, marginPerTonne: 0, sortOrder: 2 },
  HUSK_LOADING: { label: 'Husk Loading', ratePerTonne: 333, lorryPerTonne: 0, marginPerTonne: 0, sortOrder: 3 },
  TPS_LOADING: { label: 'TPS (Brokens) Loading', ratePerTonne: 160, lorryPerTonne: 160, marginPerTonne: 0, sortOrder: 4 },
  SHELL_TRANSFER: { label: 'Tamarind Shell Transfer', ratePerTonne: 333, lorryPerTonne: 0, marginPerTonne: 0, sortOrder: 5 },
  WASTE_LOADING: { label: 'Tamarind Waste Loading', ratePerTonne: 150, lorryPerTonne: 0, marginPerTonne: 0, sortOrder: 6 },
};

/** Return all hamali rate rows (fixed + custom), lazily creating missing fixed ones from defaults. */
export async function getHamaliRateRows() {
  const existing = await prisma.hamaliRate.findMany();
  const have = new Set(existing.map((r) => r.key));
  const missing = HAMALI_RATE_KEYS.filter((k) => !have.has(k));
  if (missing.length) {
    await prisma.hamaliRate.createMany({
      data: missing.map((k) => ({
        key: k,
        label: HAMALI_RATE_DEFAULTS[k].label,
        ratePerTonne: HAMALI_RATE_DEFAULTS[k].ratePerTonne,
        lorryPerTonne: HAMALI_RATE_DEFAULTS[k].lorryPerTonne,
        marginPerTonne: HAMALI_RATE_DEFAULTS[k].marginPerTonne,
        sortOrder: HAMALI_RATE_DEFAULTS[k].sortOrder,
      })),
    });
  }
  const rows = await prisma.hamaliRate.findMany();
  // Order by saved sortOrder, then the canonical key order as a tiebreak.
  return rows.sort(
    (a, b) =>
      a.sortOrder - b.sortOrder ||
      HAMALI_RATE_KEYS.indexOf(a.key as HamaliRateKey) - HAMALI_RATE_KEYS.indexOf(b.key as HamaliRateKey)
  );
}

export async function getHamaliRates(_req: Request, res: Response) {
  res.json(await getHamaliRateRows());
}

const hamaliRatesSchema = z.object({
  rates: z
    .array(
      z.object({
        key: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Z0-9_]+$/, 'Key must be uppercase letters, digits or underscores'),
        label: z.string().min(1).max(120),
        ratePerTonne: z.coerce.number().nonnegative(),
        lorryPerTonne: z.coerce.number().nonnegative().default(0),
        marginPerTonne: z.coerce.number().nonnegative().default(0),
        isCustom: z.boolean().default(false),
      })
    )
    .min(1),
});

/**
 * Replace the hamali rate set. Fixed operations keep their key; custom rows (the
 * user-added costs) are upserted, and any custom row no longer present is removed.
 * Row order is persisted via sortOrder. Lorry & margin are now editable per row.
 */
export async function updateHamaliRates(req: Request, res: Response) {
  const { rates } = hamaliRatesSchema.parse(req.body);
  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < rates.length; i++) {
      const r = rates[i];
      // A fixed key can never be flipped into a custom row (and vice-versa).
      const isFixed = (HAMALI_RATE_KEYS as readonly string[]).includes(r.key);
      const data = {
        label: r.label,
        ratePerTonne: r.ratePerTonne,
        lorryPerTonne: r.lorryPerTonne,
        marginPerTonne: r.marginPerTonne,
        isCustom: isFixed ? false : true,
        sortOrder: i,
      };
      await tx.hamaliRate.upsert({
        where: { key: r.key },
        update: data,
        create: { key: r.key, ...data },
      });
    }
    // Drop custom rows the user deleted in the UI (fixed rows are never deleted).
    const keptKeys = rates.map((r) => r.key);
    await tx.hamaliRate.deleteMany({ where: { isCustom: true, key: { notIn: keptKeys } } });
  });
  res.json(await getHamaliRateRows());
}

/** Look up a single hamali rate's total (₹/tonne), falling back to the seeded default. */
export async function getHamaliRate(key: HamaliRateKey): Promise<number> {
  const row = await prisma.hamaliRate.findUnique({ where: { key } });
  if (row) return Number(row.ratePerTonne);
  return HAMALI_RATE_DEFAULTS[key].ratePerTonne;
}

export interface HamaliSplitRates {
  total: number;
  lorry: number;
  margin: number;
}

/** Full split (total / lorry / margin) for one rate, falling back to seeded defaults. */
export async function getHamaliRateFull(key: HamaliRateKey): Promise<HamaliSplitRates> {
  const row = await prisma.hamaliRate.findUnique({ where: { key } });
  if (row) {
    return { total: Number(row.ratePerTonne), lorry: Number(row.lorryPerTonne), margin: Number(row.marginPerTonne) };
  }
  const d = HAMALI_RATE_DEFAULTS[key];
  return { total: d.ratePerTonne, lorry: d.lorryPerTonne, margin: d.marginPerTonne };
}

/** Every user-added custom cost - these are charged on each Pappu sale dispatch. */
export async function getCustomHamaliRates(): Promise<(HamaliSplitRates & { key: string; label: string })[]> {
  const rows = await prisma.hamaliRate.findMany({ where: { isCustom: true } });
  return rows.map((r) => ({
    key: r.key,
    label: r.label,
    total: Number(r.ratePerTonne),
    lorry: Number(r.lorryPerTonne),
    margin: Number(r.marginPerTonne),
  }));
}

// --- Company profile (single row, lazily created) -------------------------------

const COMPANY_ID = 'default';

/** Fetch the company profile, creating a blank default row on first access. */
export async function getCompanyProfileRow() {
  const existing = await prisma.companyProfile.findUnique({ where: { id: COMPANY_ID } });
  if (existing) return existing;
  return prisma.companyProfile.create({ data: { id: COMPANY_ID } });
}

// Secret credential fields that must never be sent back to the client. They are
// write-only from the UI's perspective: the form shows them blank and only
// overwrites the stored value when the admin types a new one.
const SECRET_FIELDS = ['taxproGspSecret', 'taxproGstPass'] as const;

/** Strip write-only secrets from a company-profile row before returning it. */
function redactCompanyProfile<T extends Record<string, unknown>>(row: T): T {
  const clone: Record<string, unknown> = { ...row };
  for (const f of SECRET_FIELDS) clone[f] = null;
  return clone as T;
}

export async function getCompanyProfile(_req: Request, res: Response) {
  res.json(redactCompanyProfile(await getCompanyProfileRow()));
}

const companyProfileSchema = z.object({
  name: z.string().trim().min(1, 'Company name is required'),
  address: z.string().optional().nullable(),
  gstin: z.string().optional().nullable(),
  stateName: z.string().optional().nullable(),
  stateCode: z.string().optional().nullable(),
  pincode: z.string().optional().nullable(),
  contact: z.string().optional().nullable(),
  bankAccountName: z.string().optional().nullable(),
  bankName: z.string().optional().nullable(),
  bankAccountNumber: z.string().optional().nullable(),
  bankBranchIfsc: z.string().optional().nullable(),
  invoicePrefix: z.string().trim().min(1).default('RVP'),
  companyVehicles: z.string().optional().nullable(),
  ownerWhatsappNumber: z.string().optional().nullable(),
  freightRetentionPerTrip: z.coerce.number().nonnegative().optional(),
  taxproGspId: z.string().optional().nullable(),
  taxproGspSecret: z.string().optional().nullable(),
  taxproGstUser: z.string().optional().nullable(),
  taxproGstPass: z.string().optional().nullable(),
  taxproSandbox: z.boolean().optional().default(true),
});

export async function updateCompanyProfile(req: Request, res: Response) {
  const data = companyProfileSchema.parse(req.body);

  // Secrets are redacted on read, so the form submits them blank unless the
  // admin typed a new value. Drop blank/undefined secret fields so a normal save
  // never wipes the stored credential — only a non-empty value overwrites it.
  for (const f of SECRET_FIELDS) {
    if (data[f] == null || data[f] === '') delete (data as Record<string, unknown>)[f];
  }

  const saved = await prisma.companyProfile.upsert({
    where: { id: COMPANY_ID },
    update: data,
    create: { id: COMPANY_ID, ...data },
  });
  res.json(redactCompanyProfile(saved));
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

const PRODUCTS = ['PAPPU', 'HUSK', 'WASTE', 'TPS', 'SHELL', 'PRECLEANER_DUST', 'NALLA_POKKULU', 'NALLA_CHINTAPANDU'] as const;
type ProductCode = (typeof PRODUCTS)[number];

const PRODUCT_TAX_DEFAULTS: Record<ProductCode, { hsn: string; description: string }> = {
  PAPPU: { hsn: '1207', description: 'Tamarind Seed Kernel' },
  HUSK: { hsn: '1404', description: 'Tamarind Husk' },
  WASTE: { hsn: '2308', description: 'Tamarind Waste' },
  TPS: { hsn: '1207', description: 'Tamarind Seed Brokens' },
  SHELL: { hsn: '1404', description: 'Tamarind Shell' },
  PRECLEANER_DUST: { hsn: '2308', description: 'Pre Cleaner Dust' },
  NALLA_POKKULU: { hsn: '2308', description: 'Nalla Pokkulu' },
  NALLA_CHINTAPANDU: { hsn: '2308', description: 'Nalla Chintapandu' },
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
        gstRate: z.coerce.number().min(0).max(100).optional().nullable(),
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
        update: { hsn: r.hsn ?? null, hsnExempt: r.hsnExempt ?? null, description: r.description ?? null, gstRate: r.gstRate ?? 5 },
        create: { product: r.product, hsn: r.hsn ?? null, hsnExempt: r.hsnExempt ?? null, description: r.description ?? null, gstRate: r.gstRate ?? 5 },
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
