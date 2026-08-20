import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { InventoryService } from '../services/inventory.service.js';
import { computePappuOrderMargins } from './inventory.controller.js';
import { computeHuskPool, HUSK_EXPENSE_META, HUSK_INCOME_META } from './dashboard.controller.js';

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
/**
 * The P&L numbers, decoupled from the Express req/res so the WhatsApp owner
 * digest (whatsappJobs.ts) can pull the same `totals.netProfit` the P&L page
 * headlines without faking a response object.
 */
export async function computeProfitLossSummary() {
  const [huskPool, byproductOrders, pappuMargins] = await Promise.all([
    computeHuskPool(),
    prisma.saleOrder.findMany({
      where: { product: { not: 'PAPPU' } },
      include: { dispatches: { select: { weightKg: true, gstAmount: true } } },
    }),
    computePappuOrderMargins(),
  ]);

  // Estimated Pappu P/L = Σ per-order margin (all orders).
  const pappuEstimatedProfit = r2(pappuMargins.reduce((s, m) => s + m.margin, 0));
  // Locked Pappu P/L = Σ per-order margin (only orders whose costs are frozen/fully dispatched).
  const lockedMargins = pappuMargins.filter((m) => m.costFrozenAt != null);
  const pappuLockedProfit = r2(lockedMargins.reduce((s, m) => s + m.margin, 0));

  // Byproduct income = actually dispatched non-Pappu sales (GST-inclusive).
  const incomeByProduct = new Map<string, number>();
  for (const so of byproductOrders) {
    const rate = Number(so.ratePerKg);
    for (const d of so.dispatches) {
      if (d.weightKg <= 0) continue;
      const amount = d.weightKg * rate + Number(d.gstAmount || 0);
      incomeByProduct.set(so.product, r2((incomeByProduct.get(so.product) ?? 0) + amount));
    }
  }
  const byproducts = [...incomeByProduct.entries()]
    .map(([product, amount]) => ({ product, amount: r2(amount) }))
    .sort((a, b) => b.amount - a.amount);
  const byproductIncome = r2(byproducts.reduce((s, b) => s + b.amount, 0));

  // Overhead = the FULL itemized husk-pool operating costs, matching the dashboard
  // recovery card line-for-line - including the pappu-flagged lines (Pappu Loading /
  // Roasting / Net), which per business instruction are deducted here as well.
  const overheadLedgers = HUSK_EXPENSE_META
    .map((m) => ({ code: m.key, name: m.label, amount: r2(huskPool.expenses[m.key]) }))
    .filter((l) => Math.abs(l.amount) >= 0.005)
    .sort((a, b) => b.amount - a.amount);
  const overheadExpenses = r2(overheadLedgers.reduce((s, l) => s + l.amount, 0));

  // Income tab streams (Kata Income, Hamali Company Profit, Gunny Sales, Other
  // Income) - added to the husk pool as income, same as the byproduct sales.
  const incomeLines = HUSK_INCOME_META
    .map((m) => ({ code: m.key, name: m.label, amount: r2(huskPool.income[m.key]) }))
    .filter((l) => Math.abs(l.amount) >= 0.005)
    .sort((a, b) => b.amount - a.amount);
  const otherIncomeTotal = r2(incomeLines.reduce((s, l) => s + l.amount, 0));

  const huskPoolNet = r2(byproductIncome + otherIncomeTotal - overheadExpenses); // surplus + / deficit −
  const estimatedNetProfit = r2(pappuEstimatedProfit + huskPoolNet);
  const lockedNetProfit = r2(pappuLockedProfit + huskPoolNet);

  return {
    period: new Date().toISOString(),
    pappu: {
      profitLoss: pappuLockedProfit,
      lockedProfit: pappuLockedProfit,
      estimatedProfit: pappuEstimatedProfit,
      orders: lockedMargins.length,
      totalOrders: pappuMargins.length,
    },
    huskPool: {
      byproductIncome,
      byproducts,
      otherIncomeTotal,
      incomeLines,
      overheadExpenses,
      overheadLedgers,
      net: huskPoolNet,
      isDeficit: huskPoolNet < 0,
    },
    totals: {
      netProfit: lockedNetProfit,
      lockedNetProfit,
      estimatedNetProfit,
      isProfit: lockedNetProfit >= 0,
    },
  };
}

export async function getProfitLoss(_req: Request, res: Response) {
  res.json(await computeProfitLossSummary());
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

// SET_OFF is a knock-off between this party's own payable and receivable. It
// appears TWICE - once on the debit side (clearing a purchase bill) and once on
// the credit side (clearing a sale invoice) - so the running balance is
// unchanged, which is the point: netting settles documents, not the net position.
type LedgerKind = 'PURCHASE' | 'SALE' | 'PAYMENT' | 'RECEIPT' | 'CREDIT_NOTE' | 'TDS' | 'SHORTAGE' | 'SET_OFF';

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
type CreditNoteRow = Awaited<ReturnType<typeof loadCreditNotes>>[number];

function loadPurchaseOrders(partyId?: string) {
  return prisma.purchaseOrder.findMany({
    where: partyId ? { partyId } : undefined,
    include: {
      stockIns: { include: { purchase: { include: { verification: true } } } },
    },
  });
}
function loadSales(buyerId?: string) {
  return prisma.saleOrder.findMany({ where: buyerId ? { buyerId } : undefined, include: { dispatches: true, broker: true } });
}

// A broker literally named "RVP" marks the company's own order, not a real
// brokered deal - so it's never worth narrating as "through RVP".
const isOwnBroker = (name?: string | null) => (name ?? '').trim().toUpperCase() === 'RVP';
function loadPayments(partyId?: string) {
  return prisma.payment.findMany({ where: { partyId: partyId ? partyId : { not: null } } });
}
function loadReceipts(partyId?: string) {
  return prisma.receipt.findMany({ where: { partyId: partyId ? partyId : { not: null } } });
}
function loadDustPurchases(partyId?: string) {
  return prisma.dustPurchase.findMany({ where: partyId ? { partyId } : undefined });
}
function loadCreditNotes(partyId?: string) {
  return prisma.creditNote.findMany({
    where: { ...(partyId ? { partyId } : {}), status: 'ISSUED' },
    include: { saleDispatch: { select: { id: true, invoiceNumber: true } } },
  });
}

function round2(n: number): number {
  return Math.round(n); // whole rupees - the ERP carries no paise
}

// Money collected against a shipment used to be narrated two different ways in
// the same statement: Mark-as-Paid baked the invoice into the description
// ("Payment for Invoice RVP/50/26-27") while Sale Dues / the Receipts page left
// it blank ("Receipt collected"). The invoice belongs in the Invoice column, so
// we peel that legacy prefix off and let every collection read the same way.
const AUTO_INVOICE_NARRATION = /^payment for invoice\s+/i;
// A cuid stand-in (rows booked before the dispatch had an invoice number) is an
// id, not something to print as an invoice.
const CUID_LIKE = /^c[a-z0-9]{20,}$/i;

function splitAutoNarration(description: string | null | undefined): {
  note: string | null;
  invoiceNumber: string | null;
} {
  const d = description?.trim();
  if (!d) return { note: null, invoiceNumber: null };
  const m = d.match(AUTO_INVOICE_NARRATION);
  if (!m) return { note: d, invoiceNumber: null };
  const token = d.slice(m[0].length).trim();
  return { note: null, invoiceNumber: token && !CUID_LIKE.test(token) ? token : null };
}

function buildPartyLedger(
  party: { id: string; type?: string; openingBalance?: any; openingBalanceType?: any } | string,
  pos: PoWithChain[],
  sales: SaleRow[],
  payments: PaymentRow[],
  receipts: ReceiptRow[],
  dustPurchases: DustPurchaseRow[],
  creditNotes: CreditNoteRow[] = []
) {
  const partyId = typeof party === 'string' ? party : party.id;
  const rawOpening = typeof party === 'object' ? Number(party.openingBalance || 0) : 0;
  const isDr = typeof party === 'object'
    ? party.openingBalanceType === 'DR' || (party.openingBalanceType !== 'CR' && party.type === 'BUYER')
    : false;
  const signedOpening = rawOpening ? (isDr ? rawOpening : -rawOpening) : 0;
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

  // TDS can be captured either on the dispatch (Mark-as-Paid) or on the receipt
  // itself (Sale Dues / Receipts page). We surface it in the ledger exactly once:
  // if a receipt tied to a dispatch already carries the deduction, we show that
  // and suppress the dispatch-level line to avoid double-counting the same amount.
  // (Shortage has no dispatch-level line at all - see the sales loop below.)
  const linkedTdsDispatchIds = new Set(
    receipts.filter((r) => r.partyId === partyId && r.saleDispatchId && Number(r.tdsAmount ?? 0) > 0).map((r) => r.saleDispatchId as string)
  );

  // Invoice + lorry of every shipment/arrival of this party, so a money line
  // booked against one cites the same invoice as the sale/purchase it clears.
  const dispatchMetaById = new Map<string, { invoiceLabel: string | null; vehicleNumber: string | null }>();
  for (const s of sales.filter((x) => x.buyerId === partyId)) {
    for (const d of s.dispatches) {
      dispatchMetaById.set(d.id, {
        invoiceLabel:
          d.invoiceNumber ?? (d.invoiceSeq && d.invoiceFy ? `${d.invoiceSeq}/${d.invoiceFy}` : null),
        vehicleNumber: d.vehicleNumber,
      });
    }
  }
  const purchaseMetaById = new Map<string, { invoiceNumber: string | null; lorryNumber: string | null }>();
  for (const po of pos.filter((p) => p.partyId === partyId)) {
    for (const si of po.stockIns) {
      if (si.purchase) {
        purchaseMetaById.set(si.purchase.id, {
          invoiceNumber: si.invoiceNumber,
          lorryNumber: si.lorryNumber,
        });
      }
    }
  }

  // 2. Sales - buyer takes goods → they owe us (DEBIT). Each dispatch (lorry) is a
  //    billed shipment; an order is only a receivable once dispatched. Credit note
  //    (delivery shortage) and TDS deducted by the buyer both reduce it.
  for (const s of sales.filter((x) => x.buyerId === partyId)) {
    const rate = Number(s.ratePerKg);
    for (const d of s.dispatches) {
      const base = round2(d.weightKg * rate);
      const gst = round2(Number(d.gstAmount));
      const invoiceLabel = dispatchMetaById.get(d.id)?.invoiceLabel ?? null;
      const brokerName = s.broker && !isOwnBroker(s.broker.name) ? s.broker.name : null;
      txns.push({
        id: `SALE-${d.id}`,
        // Ledger sale date = the day the goods left (dispatch date), not the
        // invoice date (invoices are often raised days later).
        date: d.dispatchDate.toISOString(),
        kind: 'SALE',
        particulars: brokerName ? `Sale - ${s.product} (through ${brokerName})` : `Sale - ${s.product}`,
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

      // NOTE: the buyer-kata shortage stored on the dispatch (creditNoteAmount /
      // shortageKg at Mark-as-Delivered) is deliberately NOT a ledger line. It is
      // only our expectation of what the buyer will deduct; what they actually
      // deduct is settled when the money lands. So A/R stays at the full billed
      // amount until a receipt books the deduction, and the shortage reaches the
      // ledger through that receipt (`REC-SH-` below). This matches the accounting
      // ledger - deliverSaleDispatch posts no credit-note journal entry either,
      // only postSaleShortageDeduction at receipt time - and the Sale Dues page,
      // which clears a shipment purely from its receipts.

      const tds = Number(d.tdsAmount ?? 0);
      if (tds > 0 && !linkedTdsDispatchIds.has(d.id)) {
        txns.push({
          id: `TDS-${d.id}`,
          date: (d.receivedDate ?? d.deliveredDate ?? d.dispatchDate).toISOString(),
          kind: 'TDS',
          particulars: 'TDS deducted by buyer',
          invoiceNumber: invoiceLabel,
          vehicleNumber: d.vehicleNumber,
          reference: s.destination,
          utr: null,
          transferredDate: null,
          weightKg: null,
          ratePerKg: null,
          product: s.product,
          debit: 0,
          credit: round2(tds),
          status: 'POSTED',
        });
      }
    }
  }

  // 3. Payments we made to the party (as a supplier) → DEBIT (clears payable).
  //    A set-off leg sits here too: it clears the same payable, but no money
  //    moved, so it is narrated as a set-off rather than a payment (and is left
  //    out of paidTotal below).
  for (const p of payments.filter((x) => x.partyId === partyId)) {
    const linkedPurchase = p.purchaseId ? purchaseMetaById.get(p.purchaseId) : undefined;
    const narration = splitAutoNarration(p.description);
    const isSetOff = !!p.setOffId;
    txns.push({
      id: `PAY-${p.id}`,
      date: p.date.toISOString(),
      kind: isSetOff ? 'SET_OFF' : 'PAYMENT',
      particulars: isSetOff
        ? narration.note || 'Set-off - purchase bill squared against sale invoice'
        : narration.note || 'Payment made',
      invoiceNumber: linkedPurchase?.invoiceNumber ?? narration.invoiceNumber,
      vehicleNumber: p.lorryNumber ?? linkedPurchase?.lorryNumber ?? null,
      reference: p.reference,
      utr: isSetOff ? null : p.reference,
      transferredDate: isSetOff ? null : p.date.toISOString(),
      weightKg: null,
      ratePerKg: null,
      product: null,
      debit: round2(Number(p.amount)),
      credit: 0,
      status: isSetOff ? 'SET-OFF' : 'PAID',
    });
  }

  // 4. Receipts we collected from the party (as a buyer) → CREDIT (clears A/R).
  //    A receipt can also carry a TDS and/or shortage deduction the buyer took
  //    off the invoice; each is its own credit line so the A/R clears in full.
  for (const r of receipts.filter((x) => x.partyId === partyId)) {
    const linkedDispatch = r.saleDispatchId ? dispatchMetaById.get(r.saleDispatchId) : undefined;
    const narration = splitAutoNarration(r.description);
    // Same wording for every collection, whether it came from Mark-as-Paid,
    // Sale Dues or the Receipts page; the invoice rides in its own column.
    const recInvoice = linkedDispatch?.invoiceLabel ?? narration.invoiceNumber;
    const recVehicle = linkedDispatch?.vehicleNumber ?? null;
    // A collection that was never stamped with a dispatch id settles no invoice
    // anywhere in the app, so its blank Invoice cell is a fact about the data,
    // not a gap in this report - say so rather than leaving it unexplained.
    const onAccount = !recInvoice;
    const isSetOff = !!r.setOffId;
    txns.push({
      id: `REC-${r.id}`,
      date: r.date.toISOString(),
      kind: isSetOff ? 'SET_OFF' : 'RECEIPT',
      particulars: isSetOff
        ? narration.note || 'Set-off - sale invoice squared against purchase bill'
        : narration.note || (onAccount ? 'Receipt collected (on account)' : 'Receipt collected'),
      invoiceNumber: recInvoice,
      vehicleNumber: recVehicle,
      reference: r.reference,
      utr: isSetOff ? null : r.reference,
      transferredDate: isSetOff ? null : r.date.toISOString(),
      weightKg: null,
      ratePerKg: null,
      product: null,
      debit: 0,
      credit: round2(Number(r.amount)),
      status: isSetOff ? 'SET-OFF' : 'RECEIVED',
    });

    const rTds = Number(r.tdsAmount ?? 0);
    if (rTds > 0) {
      txns.push({
        id: `REC-TDS-${r.id}`,
        date: r.date.toISOString(),
        kind: 'TDS',
        particulars: 'TDS deducted by buyer',
        invoiceNumber: recInvoice,
        vehicleNumber: recVehicle,
        reference: r.reference,
        utr: null,
        transferredDate: r.date.toISOString(),
        weightKg: null,
        ratePerKg: null,
        product: null,
        debit: 0,
        credit: round2(rTds),
        status: 'POSTED',
      });
    }

    const rShort = Number(r.shortageAmount ?? 0);
    if (rShort > 0) {
      txns.push({
        id: `REC-SH-${r.id}`,
        date: r.date.toISOString(),
        kind: 'SHORTAGE',
        particulars: 'Shortage / kata deduction',
        invoiceNumber: recInvoice,
        vehicleNumber: recVehicle,
        reference: r.reference,
        utr: null,
        transferredDate: r.date.toISOString(),
        weightKg: null,
        ratePerKg: null,
        product: null,
        debit: 0,
        credit: round2(rShort),
        status: 'POSTED',
      });
    }
  }

  // 5. Credit notes raised manually (or from the pending-shortage workflow).
  //    A credit note whose saleDispatchId matches a receipt that already booked a
  //    shortage deduction is the formal GST document for that same deduction - the
  //    money already hit the ledger through the SHORTAGE line above, so we skip it
  //    to avoid double-counting. Standalone notes (no dispatch link) and notes for
  //    dispatches with no receipt shortage are genuine new deductions.
  const dispatchIdsWithReceiptShortage = new Set(
    receipts
      .filter((r) => r.partyId === partyId && r.saleDispatchId && Number(r.shortageAmount ?? 0) > 0)
      .map((r) => r.saleDispatchId as string)
  );
  for (const cn of creditNotes.filter((c) => c.partyId === partyId)) {
    // Skip if this note formalises a shortage already deducted via a receipt.
    if (cn.saleDispatchId && dispatchIdsWithReceiptShortage.has(cn.saleDispatchId)) continue;
    txns.push({
      id: `CN-${cn.id}`,
      date: cn.noteDate.toISOString(),
      kind: 'CREDIT_NOTE',
      particulars: `Credit Note – ${cn.reason}`,
      invoiceNumber: cn.saleDispatch?.invoiceNumber ?? null,
      vehicleNumber: null,
      reference: cn.noteNumber,
      utr: null,
      transferredDate: null,
      weightKg: null,
      ratePerKg: null,
      product: null,
      debit: 0,
      credit: round2(Number(cn.totalAmount)),
      status: 'POSTED',
    });
  }

  // Chronological order, then a running balance (Dr positive / Cr negative).
  txns.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  let running = signedOpening;
  for (const t of txns) {
    running = round2(running + t.debit - t.credit);
    t.runningBalance = running;
  }

  const totalDebit = round2(txns.reduce((s, t) => s + t.debit, 0));
  const totalCredit = round2(txns.reduce((s, t) => s + t.credit, 0));
  const balance = round2(signedOpening + totalDebit - totalCredit);

  const purchaseTotal = round2(
    txns.filter((t) => t.kind === 'PURCHASE').reduce((s, t) => s + t.credit, 0)
  );
  const saleTotal = round2(
    txns.filter((t) => t.kind === 'SALE').reduce((s, t) => s + t.debit, 0)
  );
  // Paid / Received are CASH figures, so the set-off legs are excluded from both
  // and reported on their own line instead - a knock-off settles bills without a
  // rupee moving, and folding it into "Paid" would overstate what left the bank.
  const paidTotal = round2(
    txns.filter((t) => t.kind === 'PAYMENT').reduce((s, t) => s + t.debit, 0)
  );
  const receivedTotal = round2(
    txns.filter((t) => t.kind === 'RECEIPT').reduce((s, t) => s + t.credit, 0)
  );
  const setOffTotal = round2(
    txns.filter((t) => t.kind === 'SET_OFF').reduce((s, t) => s + t.debit, 0)
  );
  const pendingCount = txns.filter((t) => t.status === 'PENDING').length;
  const lastTxnDate = txns.length ? txns[txns.length - 1].date : null;

  return {
    txns,
    summary: {
      openingBalance: rawOpening,
      openingBalanceType: (isDr ? 'DR' : 'CR') as 'DR' | 'CR',
      totalDebit,
      totalCredit,
      balance: Math.abs(balance),
      balanceType: balance >= 0 ? ('DR' as const) : ('CR' as const),
      purchaseTotal,
      saleTotal,
      paidTotal,
      receivedTotal,
      setOffTotal,
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
    dustPurchases,
    creditNotesAgg
  ] = await Promise.all([
    // The Hamali crew has its own dedicated ledger view (Hamali Report -> Ledger
    // tab), so it's excluded here to avoid duplicating it in the general party list.
    prisma.party.findMany({ where: { type: { not: 'HAMALI_TEAM' } }, orderBy: { name: 'asc' } }),
    // Amounts are rounded PER TRANSACTION to whole rupees here so this list total
    // ties exactly to the per-transaction statement in getPartyLedger/buildPartyLedger.
    // (Summing raw paise and rounding once diverges by a rupee or two, which showed
    // up as a party reading e.g. ₹1 DR here while the statement said "Settled".)
    // tdsTotal excludes any dispatch whose TDS is already carried on a linked
    // receipt, so the balance ties to buildPartyLedger (which suppresses the
    // dispatch-level line in that case). The dispatch's buyer-kata shortage is
    // ignored outright - it only hits the ledger once a receipt books it, and
    // that lands via shortageTotal on the Receipt aggregate below.
    prisma.$queryRaw<{partyId: string, saleTotal: number, lastTxnDate: Date, dispatchCount: bigint, tdsTotal: number}[]>`
      SELECT
        so."buyerId" as "partyId",
        SUM(ROUND(sd."weightKg" * so."ratePerKg") + ROUND(sd."gstAmount")) as "saleTotal",
        SUM(ROUND(COALESCE(sd."tdsAmount", 0)) * (CASE WHEN EXISTS (SELECT 1 FROM "Receipt" r WHERE r."saleDispatchId" = sd.id AND COALESCE(r."tdsAmount", 0) > 0) THEN 0 ELSE 1 END)) as "tdsTotal",
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
    // \`total\` is every debit against the party (it must stay complete or the
    // balance breaks); \`setOffTotal\` splits out the cash-free knock-off legs so
    // the Paid column shows money that actually left the bank, matching
    // buildPartyLedger's paidTotal.
    prisma.$queryRaw<{partyId: string, total: number, setOffTotal: number, lastTxnDate: Date, cnt: number}[]>`
      SELECT "partyId",
        SUM(ROUND("amount")) as total,
        SUM(ROUND("amount")) FILTER (WHERE "setOffId" IS NOT NULL) as "setOffTotal",
        MAX("date") as "lastTxnDate", COUNT(*)::int as cnt
      FROM "Payment" WHERE "partyId" IS NOT NULL GROUP BY "partyId"
    `,
    prisma.$queryRaw<{partyId: string, total: number, setOffTotal: number, tdsTotal: number, shortageTotal: number, lastTxnDate: Date, cnt: number}[]>`
      SELECT "partyId",
        SUM(ROUND("amount")) as total,
        SUM(ROUND("amount")) FILTER (WHERE "setOffId" IS NOT NULL) as "setOffTotal",
        SUM(ROUND(COALESCE("tdsAmount", 0))) as "tdsTotal",
        SUM(ROUND(COALESCE("shortageAmount", 0))) as "shortageTotal",
        MAX("date") as "lastTxnDate", COUNT(*)::int as cnt
      FROM "Receipt" WHERE "partyId" IS NOT NULL GROUP BY "partyId"
    `,
    prisma.$queryRaw<{partyId: string, total: number, lastTxnDate: Date, cnt: number}[]>`
      SELECT "partyId", SUM(ROUND("amount")) as total, MAX("purchaseDate") as "lastTxnDate", COUNT(*)::int as cnt
      FROM "DustPurchase" GROUP BY "partyId"
    `,
    // Manually raised credit notes - standalone deductions not already covered by
    // a receipt shortage. Notes whose saleDispatchId matches a receipt with
    // shortageAmount > 0 are the formal GST document for that same deduction, so
    // they are excluded here to avoid double-counting.
    prisma.$queryRaw<{partyId: string, total: number, lastTxnDate: Date, cnt: number}[]>`
      SELECT "partyId",
        SUM(ROUND("totalAmount")) as total,
        MAX("noteDate") as "lastTxnDate",
        COUNT(*)::int as cnt
      FROM "CreditNote"
      WHERE status = 'ISSUED'
        AND NOT EXISTS (
          SELECT 1 FROM "Receipt" r
          WHERE r."saleDispatchId" = "CreditNote"."saleDispatchId"
            AND COALESCE(r."shortageAmount", 0) > 0
        )
      GROUP BY "partyId"
    `
  ]);

  const map = new Map<string, any>();
  for (const p of parties) {
    const rawOpening = Number((p as any).openingBalance || 0);
    const isDr = (p as any).openingBalanceType === 'DR' || ((p as any).openingBalanceType !== 'CR' && p.type === 'BUYER');
    const signedOpening = rawOpening ? (isDr ? rawOpening : -rawOpening) : 0;
    map.set(p.id, {
      ...p,
      openingBalance: rawOpening,
      openingBalanceType: isDr ? 'DR' : 'CR',
      signedOpening,
      totalDebit: 0, totalCredit: 0,
      purchaseTotal: 0, saleTotal: 0, paidTotal: 0, receivedTotal: 0, setOffTotal: 0,
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
    const tdsAmt = Number(agg.tdsTotal || 0);
    s.saleTotal += amt;
    s.totalDebit += amt;
    s.totalCredit += tdsAmt;
    s.transactionCount += Number(agg.dispatchCount);
  }
  for (const agg of payments) {
    if (!agg.partyId) continue;
    const s = map.get(agg.partyId);
    if (!s) continue;
    applyDate(agg.partyId, agg.lastTxnDate);
    const amt = Number(agg.total || 0);
    const setOffAmt = Number(agg.setOffTotal || 0);
    s.paidTotal += amt - setOffAmt; // cash only
    s.setOffTotal += setOffAmt;
    s.totalDebit += amt;
    s.transactionCount += Number(agg.cnt);
  }
  for (const agg of receipts) {
    if (!agg.partyId) continue;
    const s = map.get(agg.partyId);
    if (!s) continue;
    applyDate(agg.partyId, agg.lastTxnDate);
    const amt = Number(agg.total || 0);
    const setOffAmt = Number(agg.setOffTotal || 0);
    const tdsAmt = Number(agg.tdsTotal || 0);
    const shortageAmt = Number(agg.shortageTotal || 0);
    s.receivedTotal += amt - setOffAmt; // cash only
    s.totalCredit += amt + tdsAmt + shortageAmt;
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
  for (const agg of creditNotesAgg) {
    const s = map.get(agg.partyId);
    if (!s) continue;
    applyDate(agg.partyId, agg.lastTxnDate);
    const amt = Number(agg.total || 0);
    s.totalCredit += amt;
    s.transactionCount += Number(agg.cnt);
  }

  const rows = Array.from(map.values()).map(s => {
    s.purchaseTotal = round2(s.purchaseTotal);
    s.saleTotal = round2(s.saleTotal);
    s.paidTotal = round2(s.paidTotal);
    s.receivedTotal = round2(s.receivedTotal);
    s.setOffTotal = round2(s.setOffTotal);
    s.totalDebit = round2(s.totalDebit);
    s.totalCredit = round2(s.totalCredit);
    const bal = round2((s.signedOpening || 0) + s.totalDebit - s.totalCredit);
    s.balance = Math.abs(bal);
    s.balanceType = bal >= 0 ? 'DR' : 'CR';
    s.totalBusiness = round2(s.purchaseTotal + s.saleTotal);
    return s;
  });

  res.json(rows);
}

/**
 * Build a party's full A-to-Z account statement (transactions + summary). Shared
 * by the HTTP endpoint and the WhatsApp verification-statement PDF so both read
 * from one source of truth. Returns null when the party doesn't exist.
 */
export async function buildPartyStatementData(partyId: string) {
  const party = await prisma.party.findUnique({ where: { id: partyId } });
  if (!party) return null;

  const [pos, sales, payments, receipts, dustPurchases, creditNotes] = await Promise.all([
    loadPurchaseOrders(party.id),
    loadSales(party.id),
    loadPayments(party.id),
    loadReceipts(party.id),
    loadDustPurchases(party.id),
    loadCreditNotes(party.id),
  ]);

  const { txns, summary } = buildPartyLedger(party, pos, sales, payments, receipts, dustPurchases, creditNotes);
  return { party, transactions: txns, summary };
}

export type PartyStatementData = NonNullable<Awaited<ReturnType<typeof buildPartyStatementData>>>;

export async function getPartyLedger(req: Request, res: Response) {
  const data = await buildPartyStatementData(req.params.id);
  if (!data) throw new HttpError(404, 'Party not found');
  res.json({ party: data.party, summary: data.summary, transactions: data.transactions });
}
