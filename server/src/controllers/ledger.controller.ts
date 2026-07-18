import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { InventoryService } from '../services/inventory.service.js';
import { computePappuOrderMargins } from './inventory.controller.js';
import { computeHuskPool, HUSK_EXPENSE_META } from './dashboard.controller.js';

// ---------------------------------------------------------------------------
// Tally-style grouped reporting. Every ledger's closing balance is SIGNED:
// +Dr (assets/expenses) / −Cr (liabilities/income/capital) = openingBalance +
// Σdebit − Σcredit. Groups roll their ledgers' and child groups' closings up
// into a signed subtotal. The Balance Sheet ties because the seeded opening
// trial balance nets to zero and every journal entry is itself balanced.
// ---------------------------------------------------------------------------

interface LedgerNode {
  id: string;
  code: string;
  name: string;
  type: string;
  openingBalance: number;
  debits: number;
  credits: number;
  closing: number; // signed: +Dr / −Cr
}

interface GroupNode {
  id: string;
  name: string;
  nature: 'ASSETS' | 'LIABILITIES' | 'INCOME' | 'EXPENSES';
  statement: 'BALANCE_SHEET' | 'PROFIT_LOSS';
  sortOrder: number;
  ledgers: LedgerNode[];
  children: GroupNode[];
  subtotal: number; // signed
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Load every live (non-deprecated) ledger with its signed closing balance.
async function loadLedgerBalances(): Promise<LedgerNode[]> {
  const [accounts, sums] = await Promise.all([
    prisma.account.findMany({ where: { isDeprecated: false } }),
    prisma.journalLine.groupBy({
      by: ['accountId'],
      _sum: { debit: true, credit: true },
    }),
  ]);
  const sumMap = new Map(
    sums.map((s) => [s.accountId, { d: Number(s._sum.debit ?? 0), c: Number(s._sum.credit ?? 0) }])
  );
  return accounts.map((a) => {
    const s = sumMap.get(a.id) ?? { d: 0, c: 0 };
    const opening = Number(a.openingBalance);
    return {
      id: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
      openingBalance: opening,
      debits: r2(s.d),
      credits: r2(s.c),
      closing: r2(opening + s.d - s.c),
    };
  });
}

// Build the full group tree with rolled-up signed subtotals.
async function buildGroupTree(): Promise<GroupNode[]> {
  const [groups, ledgers] = await Promise.all([
    prisma.accountGroup.findMany(),
    loadLedgerBalances(),
  ]);

  const ledgersByGroup = new Map<string, LedgerNode[]>();
  // Map each ledger to its group (groupId lives on the account row).
  const accountGroupIds = await prisma.account.findMany({
    where: { isDeprecated: false },
    select: { id: true, groupId: true },
  });
  const gidById = new Map(accountGroupIds.map((a) => [a.id, a.groupId]));
  for (const l of ledgers) {
    const gid = gidById.get(l.id);
    if (!gid) continue;
    const arr = ledgersByGroup.get(gid) ?? [];
    arr.push(l);
    ledgersByGroup.set(gid, arr);
  }

  const childrenByParent = new Map<string | null, typeof groups>();
  for (const g of groups) {
    const key = g.parentId ?? null;
    const arr = childrenByParent.get(key) ?? [];
    arr.push(g);
    childrenByParent.set(key, arr);
  }

  const byCode = (a: LedgerNode, b: LedgerNode) => a.code.localeCompare(b.code);

  function build(g: (typeof groups)[number]): GroupNode {
    const childGroups = (childrenByParent.get(g.id) ?? [])
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(build);
    const leds = (ledgersByGroup.get(g.id) ?? []).sort(byCode);
    const subtotal = r2(
      leds.reduce((s, l) => s + l.closing, 0) + childGroups.reduce((s, c) => s + c.subtotal, 0)
    );
    return {
      id: g.id,
      name: g.name,
      nature: g.nature as GroupNode['nature'],
      statement: g.statement as GroupNode['statement'],
      sortOrder: g.sortOrder,
      ledgers: leds,
      children: childGroups,
      subtotal,
    };
  }

  return (childrenByParent.get(null) ?? [])
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(build);
}

// Current-period net profit from the P&L statement groups (perpetual basis:
// COGS already relieves stock, so no opening/closing-stock adjustment needed).
function currentPeriodNetProfit(roots: GroupNode[]): {
  totalIncome: number;
  totalExpenses: number;
  netProfit: number;
} {
  const pl = roots.filter((r) => r.statement === 'PROFIT_LOSS');
  const totalIncome = r2(
    pl.filter((r) => r.nature === 'INCOME').reduce((s, r) => s - r.subtotal, 0)
  ); // income is Cr → −signed = positive
  const totalExpenses = r2(
    pl.filter((r) => r.nature === 'EXPENSES').reduce((s, r) => s + r.subtotal, 0)
  );
  return { totalIncome, totalExpenses, netProfit: r2(totalIncome - totalExpenses) };
}

export async function listAccounts(_req: Request, res: Response) {
  const tree = await buildGroupTree();
  res.json(tree);
}

// ── Tally Balance Sheet: two-column (Liabilities | Assets) display amounts.
//    Liabilities/Capital shown Cr-positive; Assets shown Dr-positive. ──
type DisplayNode = {
  name: string;
  amount: number;
  code?: string;
  ledgers?: { code: string; name: string; amount: number }[];
  children?: DisplayNode[];
};

function toDisplay(node: GroupNode, crPositive: boolean): DisplayNode {
  const sign = crPositive ? -1 : 1;
  return {
    name: node.name,
    amount: r2(sign * node.subtotal),
    ledgers: node.ledgers.map((l) => ({ code: l.code, name: l.name, amount: r2(sign * l.closing) })),
    children: node.children.map((c) => toDisplay(c, crPositive)),
  };
}

export async function getBalanceSheet(_req: Request, res: Response) {
  const roots = await buildGroupTree();
  const { totalIncome, totalExpenses, netProfit } = currentPeriodNetProfit(roots);

  const bs = roots.filter((r) => r.statement === 'BALANCE_SHEET');
  const assets = bs
    .filter((r) => r.nature === 'ASSETS')
    .map((r) => toDisplay(r, false));

  const liabilities = bs
    .filter((r) => r.nature === 'LIABILITIES')
    .map((r) => {
      const d = toDisplay(r, true);
      // Inject the current-period net profit into the Profit & Loss A/c group.
      if (r.name === 'Profit & Loss A/c') {
        d.ledgers = [
          ...(d.ledgers ?? []),
          { code: '-', name: 'Current Period (Net Profit)', amount: r2(netProfit) },
        ];
        d.amount = r2(d.amount + netProfit);
      }
      return d;
    });

  const assetsTotal = r2(assets.reduce((s, g) => s + g.amount, 0));
  const liabilitiesTotal = r2(liabilities.reduce((s, g) => s + g.amount, 0));

  res.json({
    asOf: new Date().toISOString(),
    liabilities,
    assets,
    totals: {
      liabilities: liabilitiesTotal,
      assets: assetsTotal,
      difference: r2(liabilitiesTotal - assetsTotal),
      balanced: Math.abs(liabilitiesTotal - assetsTotal) < 1,
    },
    profitAndLoss: { totalIncome, totalExpenses, netProfit },
  });
}

// ── Profit & Loss (management view) ──
//   Pappu P/L (from the per-order margins report) is the core-product result.
//   The "husk pool" collects ALL byproduct income (husk/shell/waste/etc.) and
//   absorbs every operating overhead. A pool surplus is added to the Pappu P/L;
//   a pool deficit is deducted from it. The remainder is the net P/L.
export async function getProfitLoss(_req: Request, res: Response) {
  const [huskPool, byproductOrders, pappuMargins] = await Promise.all([
    computeHuskPool(),
    prisma.saleOrder.findMany({
      where: { product: { not: 'PAPPU' } },
      include: { dispatches: { select: { weightKg: true } } },
    }),
    computePappuOrderMargins(),
  ]);

  // Pappu P/L = Σ per-order margin (seed + production + freight + brokerage netted).
  const pappuProfitLoss = r2(pappuMargins.reduce((s, m) => s + m.margin, 0));

  // Byproduct income = actually dispatched non-Pappu sales (GST is pass-through, excluded).
  const incomeByProduct = new Map<string, number>();
  for (const so of byproductOrders) {
    const rate = Number(so.ratePerKg);
    const dispatchedKg = so.dispatches.reduce((s, d) => s + d.weightKg, 0);
    if (dispatchedKg <= 0) continue;
    incomeByProduct.set(so.product, r2((incomeByProduct.get(so.product) ?? 0) + dispatchedKg * rate));
  }
  const byproducts = [...incomeByProduct.entries()]
    .map(([product, amount]) => ({ product, amount: r2(amount) }))
    .sort((a, b) => b.amount - a.amount);
  const byproductIncome = r2(byproducts.reduce((s, b) => s + b.amount, 0));

  // Overhead = the FULL itemized husk-pool operating costs, matching the dashboard
  // recovery card line-for-line — including the pappu-flagged lines (Pappu Loading /
  // Roasting / Net), which per business instruction are deducted here as well.
  const overheadLedgers = HUSK_EXPENSE_META
    .map((m) => ({ code: m.key, name: m.label, amount: r2(huskPool.expenses[m.key]) }))
    .filter((l) => Math.abs(l.amount) >= 0.005)
    .sort((a, b) => b.amount - a.amount);
  const overheadExpenses = r2(overheadLedgers.reduce((s, l) => s + l.amount, 0));

  const huskPoolNet = r2(byproductIncome - overheadExpenses); // surplus + / deficit −
  const netProfit = r2(pappuProfitLoss + huskPoolNet);

  res.json({
    period: new Date().toISOString(),
    pappu: { profitLoss: pappuProfitLoss, orders: pappuMargins.length },
    huskPool: {
      byproductIncome,
      byproducts,
      overheadExpenses,
      overheadLedgers,
      net: huskPoolNet,
      isDeficit: huskPoolNet < 0,
    },
    totals: {
      netProfit,
      isProfit: netProfit >= 0,
    },
  });
}

export async function listJournalEntries(req: Request, res: Response) {
  const entries = await prisma.journalEntry.findMany({
    take: 100,
    orderBy: { date: 'desc' },
    include: {
      lines: {
        include: {
          account: true
        }
      }
    }
  });
  res.json(entries);
}

export async function listSilos(req: Request, res: Response) {
  const silos = await InventoryService.listSilos();
  res.json(silos);
}

// ---------------------------------------------------------------------------
// Party ledger - a single A-to-Z account statement per party combining
// purchases (we owe a supplier → CR), sales (a buyer owes us → DR), payments
// made (DR) and receipts collected (CR), Tally-style. A positive running
// balance is a debit (receivable from a buyer); a negative one is a credit
// (payable to a supplier).
// ---------------------------------------------------------------------------

type LedgerKind = 'PURCHASE' | 'SALE' | 'PAYMENT' | 'RECEIPT' | 'CREDIT_NOTE';

interface LedgerTxn {
  id: string;
  date: string;
  kind: LedgerKind;
  particulars: string;
  invoiceNumber: string | null;
  vehicleNumber: string | null;
  reference: string | null; // PO no / sale ref / context
  utr: string | null; // bank UTR / cheque ref for money movements
  transferredDate: string | null; // value date of a payment/receipt
  weightKg: number | null;
  ratePerKg: number | null;
  product: string | null;
  debit: number;
  credit: number;
  status: string;
  runningBalance?: number;
}

// Prisma payloads loaded in bulk and grouped per party.
type PoWithChain = Awaited<ReturnType<typeof loadPurchaseOrders>>[number];
type SaleRow = Awaited<ReturnType<typeof loadSales>>[number];
type PaymentRow = Awaited<ReturnType<typeof loadPayments>>[number];
type ReceiptRow = Awaited<ReturnType<typeof loadReceipts>>[number];
type DustPurchaseRow = Awaited<ReturnType<typeof loadDustPurchases>>[number];

function loadPurchaseOrders(partyId?: string) {
  return prisma.purchaseOrder.findMany({
    where: partyId ? { partyId } : undefined,
    include: {
      stockIns: { include: { purchase: { include: { verification: true } } } },
    },
  });
}
function loadSales(buyerId?: string) {
  return prisma.saleOrder.findMany({ where: buyerId ? { buyerId } : undefined, include: { dispatches: true } });
}
function loadPayments(partyId?: string) {
  return prisma.payment.findMany({ where: { partyId: partyId ? partyId : { not: null } } });
}
function loadReceipts(partyId?: string) {
  return prisma.receipt.findMany({ where: { partyId: partyId ? partyId : { not: null } } });
}
function loadDustPurchases(partyId?: string) {
  return prisma.dustPurchase.findMany({ where: partyId ? { partyId } : undefined });
}

function round2(n: number): number {
  return Math.round(n); // whole rupees - the ERP carries no paise
}

function buildPartyLedger(
  partyId: string,
  pos: PoWithChain[],
  sales: SaleRow[],
  payments: PaymentRow[],
  receipts: ReceiptRow[],
  dustPurchases: DustPurchaseRow[]
) {
  const txns: LedgerTxn[] = [];

  // 1. Purchases - supplier supplies stock → we owe them (CREDIT).
  for (const po of pos.filter((p) => p.partyId === partyId)) {
    for (const si of po.stockIns) {
      const purchase = si.purchase;
      const v = purchase?.verification;
      if (v) {
        txns.push({
          id: `PUR-${si.id}`,
          date: si.arrivalDate.toISOString(),
          kind: 'PURCHASE',
          particulars: 'Black-seed purchase',
          invoiceNumber: si.invoiceNumber,
          vehicleNumber: si.lorryNumber,
          reference: po.poNumber,
          utr: null,
          transferredDate: null,
          weightKg: v.finalWeightKg,
          ratePerKg: Number(v.pricePerKg),
          product: 'BLACK SEED',
          debit: 0,
          credit: round2(Number(v.totalAmount)),
          status: 'POSTED',
        });
      } else {
        // Stock arrived but not yet weight-verified - listed for visibility, no
        // ledger impact until the payable amount is confirmed.
        txns.push({
          id: `PUR-${si.id}`,
          date: si.arrivalDate.toISOString(),
          kind: 'PURCHASE',
          particulars: 'Black-seed arrival (awaiting verification)',
          invoiceNumber: si.invoiceNumber,
          vehicleNumber: si.lorryNumber,
          reference: po.poNumber,
          utr: null,
          transferredDate: null,
          weightKg: si.rvpKataKg,
          ratePerKg: Number(po.pricePerKg),
          product: 'BLACK SEED',
          debit: 0,
          credit: 0,
          status: 'PENDING',
        });
      }
    }
  }

  // 1b. Pre-cleaner dust bought IN from the party → we owe them (CREDIT).
  for (const dp of dustPurchases.filter((x) => x.partyId === partyId)) {
    txns.push({
      id: `DUST-${dp.id}`,
      date: dp.purchaseDate.toISOString(),
      kind: 'PURCHASE',
      particulars: 'Pre-cleaner dust purchase',
      invoiceNumber: dp.invoiceNumber,
      vehicleNumber: dp.lorryNumber,
      reference: null,
      utr: null,
      transferredDate: null,
      weightKg: dp.weightKg,
      ratePerKg: Number(dp.pricePerKg),
      product: 'PRE CLEANER DUST',
      debit: 0,
      credit: round2(Number(dp.amount)),
      status: 'POSTED',
    });
  }

  // 2. Sales - buyer takes goods → they owe us (DEBIT). Each dispatch (lorry) is a
  //    billed shipment; an order is only a receivable once dispatched. Credit note
  //    (delivery shortage) reduces it.
  for (const s of sales.filter((x) => x.buyerId === partyId)) {
    const rate = Number(s.ratePerKg);
    for (const d of s.dispatches) {
      const base = round2(d.weightKg * rate);
      const gst = round2(Number(d.gstAmount));
      const invoiceLabel =
        d.invoiceNumber ?? (d.invoiceSeq && d.invoiceFy ? `${d.invoiceSeq}/${d.invoiceFy}` : null);
      txns.push({
        id: `SALE-${d.id}`,
        date: (d.invoiceDate ?? d.dispatchDate).toISOString(),
        kind: 'SALE',
        particulars: `Sale - ${s.product}`,
        invoiceNumber: invoiceLabel,
        vehicleNumber: d.vehicleNumber,
        reference: s.destination,
        utr: null,
        transferredDate: null,
        weightKg: d.weightKg,
        ratePerKg: rate,
        product: s.product,
        debit: round2(base + gst),
        credit: 0,
        status: d.status,
      });

      const cn = Number(d.creditNoteAmount ?? 0);
      if (cn > 0) {
        txns.push({
          id: `CN-${d.id}`,
          date: (d.receivedDate ?? d.deliveredDate ?? d.dispatchDate).toISOString(),
          kind: 'CREDIT_NOTE',
          particulars: `Credit note - shortage ${d.shortageKg ?? 0} kg`,
          invoiceNumber: invoiceLabel,
          vehicleNumber: d.vehicleNumber,
          reference: s.destination,
          utr: null,
          transferredDate: null,
          weightKg: d.shortageKg ?? null,
          ratePerKg: rate,
          product: s.product,
          debit: 0,
          credit: round2(cn),
          status: 'POSTED',
        });
      }
    }
  }

  // 3. Payments we made to the party (as a supplier) → DEBIT (clears payable).
  for (const p of payments.filter((x) => x.partyId === partyId)) {
    txns.push({
      id: `PAY-${p.id}`,
      date: p.date.toISOString(),
      kind: 'PAYMENT',
      particulars: p.description || 'Payment made',
      invoiceNumber: null,
      vehicleNumber: null,
      reference: p.reference,
      utr: p.reference,
      transferredDate: p.date.toISOString(),
      weightKg: null,
      ratePerKg: null,
      product: null,
      debit: round2(Number(p.amount)),
      credit: 0,
      status: 'PAID',
    });
  }

  // 4. Receipts we collected from the party (as a buyer) → CREDIT (clears A/R).
  for (const r of receipts.filter((x) => x.partyId === partyId)) {
    txns.push({
      id: `REC-${r.id}`,
      date: r.date.toISOString(),
      kind: 'RECEIPT',
      particulars: r.description || 'Receipt collected',
      invoiceNumber: null,
      vehicleNumber: null,
      reference: r.reference,
      utr: r.reference,
      transferredDate: r.date.toISOString(),
      weightKg: null,
      ratePerKg: null,
      product: null,
      debit: 0,
      credit: round2(Number(r.amount)),
      status: 'RECEIVED',
    });
  }

  // Chronological order, then a running balance (Dr positive / Cr negative).
  txns.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  let running = 0;
  for (const t of txns) {
    running = round2(running + t.debit - t.credit);
    t.runningBalance = running;
  }

  const totalDebit = round2(txns.reduce((s, t) => s + t.debit, 0));
  const totalCredit = round2(txns.reduce((s, t) => s + t.credit, 0));
  const balance = round2(totalDebit - totalCredit);

  const purchaseTotal = round2(
    txns.filter((t) => t.kind === 'PURCHASE').reduce((s, t) => s + t.credit, 0)
  );
  const saleTotal = round2(
    txns.filter((t) => t.kind === 'SALE').reduce((s, t) => s + t.debit, 0)
  );
  const paidTotal = round2(
    txns.filter((t) => t.kind === 'PAYMENT').reduce((s, t) => s + t.debit, 0)
  );
  const receivedTotal = round2(
    txns.filter((t) => t.kind === 'RECEIPT').reduce((s, t) => s + t.credit, 0)
  );
  const pendingCount = txns.filter((t) => t.status === 'PENDING').length;
  const lastTxnDate = txns.length ? txns[txns.length - 1].date : null;

  return {
    txns,
    summary: {
      totalDebit,
      totalCredit,
      balance: Math.abs(balance),
      balanceType: balance >= 0 ? ('DR' as const) : ('CR' as const),
      purchaseTotal,
      saleTotal,
      paidTotal,
      receivedTotal,
      totalBusiness: round2(purchaseTotal + saleTotal),
      transactionCount: txns.length,
      pendingCount,
      lastTxnDate,
    },
  };
}

export async function listPartyLedgers(_req: Request, res: Response) {
  const [
    parties,
    salesAgg,
    purchasesAgg,
    pendingPurchasesAgg,
    payments,
    receipts,
    dustPurchases
  ] = await Promise.all([
    // The Hamali crew has its own dedicated ledger view (Hamali Report -> Ledger
    // tab), so it's excluded here to avoid duplicating it in the general party list.
    prisma.party.findMany({ where: { type: { not: 'HAMALI_TEAM' } }, orderBy: { name: 'asc' } }),
    // Amounts are rounded PER TRANSACTION to whole rupees here so this list total
    // ties exactly to the per-transaction statement in getPartyLedger/buildPartyLedger.
    // (Summing raw paise and rounding once diverges by a rupee or two, which showed
    // up as a party reading e.g. ₹1 DR here while the statement said "Settled".)
    prisma.$queryRaw<{partyId: string, saleTotal: number, lastTxnDate: Date, dispatchCount: bigint, cnTotal: number}[]>`
      SELECT
        so."buyerId" as "partyId",
        SUM(ROUND(sd."weightKg" * so."ratePerKg") + ROUND(sd."gstAmount")) as "saleTotal",
        SUM(ROUND(sd."creditNoteAmount")) as "cnTotal",
        MAX(COALESCE(sd."invoiceDate", sd."dispatchDate")) as "lastTxnDate",
        COUNT(sd.id) as "dispatchCount"
      FROM "SaleOrder" so
      JOIN "SaleDispatch" sd ON sd."saleOrderId" = so.id
      GROUP BY so."buyerId"
    `,
    prisma.$queryRaw<{partyId: string, purchaseTotal: number, lastTxnDate: Date, verifiedCount: bigint}[]>`
      SELECT
        po."partyId",
        SUM(ROUND(v."totalAmount")) as "purchaseTotal",
        MAX(si."arrivalDate") as "lastTxnDate",
        COUNT(v.id) as "verifiedCount"
      FROM "PurchaseOrder" po
      JOIN "StockIn" si ON si."purchaseOrderId" = po.id
      JOIN "Purchase" p ON p."stockInId" = si.id
      JOIN "WeightVerification" v ON v."purchaseId" = p.id
      GROUP BY po."partyId"
    `,
    prisma.$queryRaw<{partyId: string, pendingCount: bigint}[]>`
      SELECT 
        po."partyId",
        COUNT(si.id) as "pendingCount"
      FROM "PurchaseOrder" po
      JOIN "StockIn" si ON si."purchaseOrderId" = po.id
      LEFT JOIN "Purchase" p ON p."stockInId" = si.id
      LEFT JOIN "WeightVerification" v ON v."purchaseId" = p.id
      WHERE v.id IS NULL
      GROUP BY po."partyId"
    `,
    prisma.$queryRaw<{partyId: string, total: number, lastTxnDate: Date, cnt: number}[]>`
      SELECT "partyId", SUM(ROUND("amount")) as total, MAX("date") as "lastTxnDate", COUNT(*)::int as cnt
      FROM "Payment" WHERE "partyId" IS NOT NULL GROUP BY "partyId"
    `,
    prisma.$queryRaw<{partyId: string, total: number, lastTxnDate: Date, cnt: number}[]>`
      SELECT "partyId", SUM(ROUND("amount")) as total, MAX("date") as "lastTxnDate", COUNT(*)::int as cnt
      FROM "Receipt" WHERE "partyId" IS NOT NULL GROUP BY "partyId"
    `,
    prisma.$queryRaw<{partyId: string, total: number, lastTxnDate: Date, cnt: number}[]>`
      SELECT "partyId", SUM(ROUND("amount")) as total, MAX("purchaseDate") as "lastTxnDate", COUNT(*)::int as cnt
      FROM "DustPurchase" GROUP BY "partyId"
    `
  ]);

  const map = new Map<string, any>();
  for (const p of parties) {
    map.set(p.id, {
      ...p,
      totalDebit: 0, totalCredit: 0,
      purchaseTotal: 0, saleTotal: 0, paidTotal: 0, receivedTotal: 0,
      transactionCount: 0, pendingCount: 0, lastTxnDate: null
    });
  }

  const applyDate = (pid: string, d: Date | null) => {
    if (!d) return;
    const s = map.get(pid);
    if (!s) return;
    if (!s.lastTxnDate || d.getTime() > new Date(s.lastTxnDate).getTime()) s.lastTxnDate = d;
  };

  for (const agg of purchasesAgg) {
    const s = map.get(agg.partyId);
    if (!s) continue;
    applyDate(agg.partyId, agg.lastTxnDate);
    const amt = Number(agg.purchaseTotal || 0);
    s.purchaseTotal += amt;
    s.totalCredit += amt;
    s.transactionCount += Number(agg.verifiedCount);
  }
  for (const agg of pendingPurchasesAgg) {
    const s = map.get(agg.partyId);
    if (!s) continue;
    s.pendingCount += Number(agg.pendingCount);
    s.transactionCount += Number(agg.pendingCount);
  }
  for (const agg of salesAgg) {
    const s = map.get(agg.partyId);
    if (!s) continue;
    applyDate(agg.partyId, agg.lastTxnDate);
    const amt = Number(agg.saleTotal || 0);
    const cnAmt = Number(agg.cnTotal || 0);
    s.saleTotal += amt;
    s.totalDebit += amt;
    s.totalCredit += cnAmt;
    s.transactionCount += Number(agg.dispatchCount);
  }
  for (const agg of payments) {
    if (!agg.partyId) continue;
    const s = map.get(agg.partyId);
    if (!s) continue;
    applyDate(agg.partyId, agg.lastTxnDate);
    const amt = Number(agg.total || 0);
    s.paidTotal += amt;
    s.totalDebit += amt;
    s.transactionCount += Number(agg.cnt);
  }
  for (const agg of receipts) {
    if (!agg.partyId) continue;
    const s = map.get(agg.partyId);
    if (!s) continue;
    applyDate(agg.partyId, agg.lastTxnDate);
    const amt = Number(agg.total || 0);
    s.receivedTotal += amt;
    s.totalCredit += amt;
    s.transactionCount += Number(agg.cnt);
  }
  for (const agg of dustPurchases) {
    const s = map.get(agg.partyId);
    if (!s) continue;
    applyDate(agg.partyId, agg.lastTxnDate);
    const amt = Number(agg.total || 0);
    s.purchaseTotal += amt;
    s.totalCredit += amt;
    s.transactionCount += Number(agg.cnt);
  }

  const rows = Array.from(map.values()).map(s => {
    s.purchaseTotal = round2(s.purchaseTotal);
    s.saleTotal = round2(s.saleTotal);
    s.paidTotal = round2(s.paidTotal);
    s.receivedTotal = round2(s.receivedTotal);
    s.totalDebit = round2(s.totalDebit);
    s.totalCredit = round2(s.totalCredit);
    const bal = round2(s.totalDebit - s.totalCredit);
    s.balance = Math.abs(bal);
    s.balanceType = bal >= 0 ? 'DR' : 'CR';
    s.totalBusiness = round2(s.purchaseTotal + s.saleTotal);
    return s;
  });

  res.json(rows);
}

export async function getPartyLedger(req: Request, res: Response) {
  const party = await prisma.party.findUnique({ where: { id: req.params.id } });
  if (!party) throw new HttpError(404, 'Party not found');

  const [pos, sales, payments, receipts, dustPurchases] = await Promise.all([
    loadPurchaseOrders(party.id),
    loadSales(party.id),
    loadPayments(party.id),
    loadReceipts(party.id),
    loadDustPurchases(party.id),
  ]);

  const { txns, summary } = buildPartyLedger(party.id, pos, sales, payments, receipts, dustPurchases);
  res.json({ party, summary, transactions: txns });
}
