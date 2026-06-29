import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { InventoryService } from '../services/inventory.service.js';

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
          { code: '—', name: 'Current Period (Net Profit)', amount: r2(netProfit) },
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

// ── Tally Profit & Loss: income vs expenses with net profit. ──
export async function getProfitLoss(_req: Request, res: Response) {
  const roots = await buildGroupTree();
  const { totalIncome, totalExpenses, netProfit } = currentPeriodNetProfit(roots);

  const pl = roots.filter((r) => r.statement === 'PROFIT_LOSS');
  const income = pl.filter((r) => r.nature === 'INCOME').map((r) => toDisplay(r, true));
  const expenses = pl.filter((r) => r.nature === 'EXPENSES').map((r) => toDisplay(r, false));

  res.json({
    period: new Date().toISOString(),
    income,
    expenses,
    totals: {
      income: totalIncome,
      expenses: totalExpenses,
      netProfit,
      isProfit: netProfit >= 0,
    },
  });
}

export async function listJournalEntries(req: Request, res: Response) {
  const entries = await prisma.journalEntry.findMany({
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
// Party ledger — a single A-to-Z account statement per party combining
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

function loadPurchaseOrders() {
  return prisma.purchaseOrder.findMany({
    include: {
      stockIns: { include: { purchase: { include: { verification: true } } } },
    },
  });
}
function loadSales() {
  return prisma.saleOrder.findMany({ include: { dispatches: true } });
}
function loadPayments() {
  return prisma.payment.findMany({ where: { partyId: { not: null } } });
}
function loadReceipts() {
  return prisma.receipt.findMany({ where: { partyId: { not: null } } });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function buildPartyLedger(
  partyId: string,
  pos: PoWithChain[],
  sales: SaleRow[],
  payments: PaymentRow[],
  receipts: ReceiptRow[]
) {
  const txns: LedgerTxn[] = [];

  // 1. Purchases — supplier supplies stock → we owe them (CREDIT).
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
        // Stock arrived but not yet weight-verified — listed for visibility, no
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

  // 2. Sales — buyer takes goods → they owe us (DEBIT). Each dispatch (lorry) is a
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
        particulars: `Sale — ${s.product}`,
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
          particulars: `Credit note — shortage ${d.shortageKg ?? 0} kg`,
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
  const [parties, pos, sales, payments, receipts] = await Promise.all([
    prisma.party.findMany({ orderBy: { name: 'asc' } }),
    loadPurchaseOrders(),
    loadSales(),
    loadPayments(),
    loadReceipts(),
  ]);

  const rows = parties.map((party) => {
    const { summary } = buildPartyLedger(party.id, pos, sales, payments, receipts);
    return { ...party, ...summary };
  });

  res.json(rows);
}

export async function getPartyLedger(req: Request, res: Response) {
  const party = await prisma.party.findUnique({ where: { id: req.params.id } });
  if (!party) throw new HttpError(404, 'Party not found');

  const [pos, sales, payments, receipts] = await Promise.all([
    loadPurchaseOrders(),
    loadSales(),
    loadPayments(),
    loadReceipts(),
  ]);

  const { txns, summary } = buildPartyLedger(party.id, pos, sales, payments, receipts);
  res.json({ party, summary, transactions: txns });
}
