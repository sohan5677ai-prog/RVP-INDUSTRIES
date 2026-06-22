import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { InventoryService } from '../services/inventory.service.js';

export async function listAccounts(req: Request, res: Response) {
  const accounts = await prisma.account.findMany({
    orderBy: { code: 'asc' },
    include: {
      lines: {
        include: { journalEntry: true }
      }
    }
  });

  // Calculate actual balances: Debit - Credit for Assets/Expenses, Credit - Debit for Liabilities/Equity/Revenues
  const formatted = accounts.map((a) => {
    const totalDebits = a.lines.reduce((sum, l) => sum + Number(l.debit), 0);
    const totalCredits = a.lines.reduce((sum, l) => sum + Number(l.credit), 0);
    
    let balance = 0;
    if (a.type === 'ASSET' || a.type === 'EXPENSE') {
      balance = totalDebits - totalCredits;
    } else {
      balance = totalCredits - totalDebits;
    }

    return {
      id: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
      debits: totalDebits,
      credits: totalCredits,
      balance,
    };
  });

  res.json(formatted);
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
  return prisma.saleOrder.findMany();
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

  // 2. Sales — buyer takes goods → they owe us (DEBIT). Credit note reduces it.
  for (const s of sales.filter((x) => x.buyerId === partyId)) {
    const base = round2((s.tonnageKg * Number(s.ratePerKg)));
    const gst = round2(Number(s.gstAmount));
    const invoiceLabel =
      s.invoiceNumber ?? (s.invoiceSeq && s.invoiceFy ? `${s.invoiceSeq}/${s.invoiceFy}` : null);
    txns.push({
      id: `SALE-${s.id}`,
      date: (s.invoiceDate ?? s.saleDate).toISOString(),
      kind: 'SALE',
      particulars: `Sale — ${s.product}`,
      invoiceNumber: invoiceLabel,
      vehicleNumber: s.vehicleNumber,
      reference: s.destination,
      utr: null,
      transferredDate: null,
      weightKg: s.tonnageKg,
      ratePerKg: Number(s.ratePerKg),
      product: s.product,
      debit: round2(base + gst),
      credit: 0,
      status: s.status,
    });

    const cn = Number(s.creditNoteAmount ?? 0);
    if (cn > 0) {
      txns.push({
        id: `CN-${s.id}`,
        date: (s.receivedDate ?? s.saleDate).toISOString(),
        kind: 'CREDIT_NOTE',
        particulars: `Credit note — shortage ${s.shortageKg ?? 0} kg`,
        invoiceNumber: invoiceLabel,
        vehicleNumber: s.vehicleNumber,
        reference: s.destination,
        utr: null,
        transferredDate: null,
        weightKg: s.shortageKg ?? null,
        ratePerKg: Number(s.ratePerKg),
        product: s.product,
        debit: 0,
        credit: round2(cn),
        status: 'POSTED',
      });
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
