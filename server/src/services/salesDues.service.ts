import { prisma } from '../lib/prisma.js';

/**
 * Server-side sales-dues (buyer receivables) computation. This mirrors the
 * client logic in `client/src/lib/saleStatus.ts` (dispatchTotal / settledByDispatch
 * / isDispatchPaid) so the scheduled WhatsApp reminders (buyer dues reminder #7 and
 * the owner dues digest #10) agree with the Sale Dues page.
 *
 * Per dispatch: invoice value = round(weight × rate + gstAmount); a shipment is
 * cleared by its directly-linked BUYER receipts (cash + TDS + shortage all count).
 * Outstanding = invoice value − cleared, with a whole-rupee tolerance (bills round
 * to whole rupees while receipt TDS/shortage carry paise).
 *
 * Due date: the credit clock starts at delivery, so dueDate = (deliveredDate ??
 * dispatchDate) + order.dueDays. An invoice is overdue once that date has passed.
 */

const TOLERANCE = 1; // sub-₹1 remainder is rounding noise - treat as settled

export interface InvoiceDue {
  dispatchId: string;
  invoiceNumber: string;
  outstanding: number;
  dueDate: Date;
  overdue: boolean;
  /** Broker on the order this shipment came from - null for our own orders. */
  brokerId: string | null;
}

/** A broker standing behind at least one of a buyer's unsettled invoices. */
export interface DuesBroker {
  id: string;
  name: string;
  phone: string | null;
}

export interface BuyerDues {
  buyerId: string;
  name: string;
  phone: string | null;
  phone2?: string | null;
  outstanding: number; // total across all unsettled shipments
  overdueOutstanding: number; // subset that is past its due date
  invoices: InvoiceDue[];
  overdueInvoices: InvoiceDue[];
  /** Distinct brokers on the unsettled invoices, "RVP" (our own) excluded. */
  brokers: DuesBroker[];
}

/**
 * A broker named "RVP" is us - the order was taken directly, so there is nobody
 * external to copy. Same rule the dispatch bundle uses.
 */
export function isOwnBrokerName(name: string | null | undefined): boolean {
  return !name || name.trim().toUpperCase() === 'RVP';
}

export interface DuesPortfolio {
  asOf: Date;
  buyers: BuyerDues[];
  totalReceivable: number;
  totalOverdue: number;
  /** Buyers with the largest outstanding, most first. */
  topPending: Array<{ name: string; outstanding: number }>;
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Compute every buyer's outstanding + overdue shipments as of `asOf` (default
 * now). Pass `buyerId` to scope the scan to one party - the Party Ledger's
 * payment-reminder button only ever needs that party's book.
 */
export async function computeBuyerDues(
  asOf: Date = new Date(),
  opts: { buyerId?: string } = {},
): Promise<DuesPortfolio> {
  const dispatches = await prisma.saleDispatch.findMany({
    where: opts.buyerId ? { saleOrder: { buyerId: opts.buyerId } } : undefined,
    include: {
      saleOrder: {
        include: {
          buyer: { select: { id: true, name: true, phone: true, phone2: true } },
          broker: { select: { id: true, name: true, phone: true } },
        },
      },
      receipts: { select: { type: true, amount: true, tdsAmount: true, shortageAmount: true } },
    },
  });

  const byBuyer = new Map<string, BuyerDues>();

  for (const d of dispatches) {
    const order = d.saleOrder;
    const rate = Number(order.ratePerKg);
    const invoiceValue = Math.round(d.weightKg * rate + Number(d.gstAmount || 0));

    const cleared = d.receipts.reduce((sum, r) => {
      if (r.type !== 'BUYER') return sum;
      return sum + Number(r.amount) + Number(r.tdsAmount ?? 0) + Number(r.shortageAmount ?? 0);
    }, 0);

    const outstanding = invoiceValue - cleared;
    if (outstanding <= TOLERANCE) continue; // settled

    const base = d.deliveredDate ?? d.dispatchDate;
    const dueDate = addDays(base, order.dueDays ?? 0);
    const overdue = dueDate.getTime() < asOf.getTime();

    const buyer = order.buyer;
    let row = byBuyer.get(buyer.id);
    if (!row) {
      row = { buyerId: buyer.id, name: buyer.name, phone: buyer.phone, phone2: buyer.phone2, outstanding: 0, overdueOutstanding: 0, invoices: [], overdueInvoices: [], brokers: [] };
      byBuyer.set(buyer.id, row);
    }
    const broker = order.broker && !isOwnBrokerName(order.broker.name) ? order.broker : null;
    const invoice: InvoiceDue = {
      dispatchId: d.id,
      invoiceNumber: d.invoiceNumber ?? `Dispatch ${d.id.slice(-6)}`,
      outstanding: Math.round(outstanding),
      dueDate,
      overdue,
      brokerId: broker?.id ?? null,
    };
    row.outstanding += invoice.outstanding;
    row.invoices.push(invoice);
    if (overdue) {
      row.overdueOutstanding += invoice.outstanding;
      row.overdueInvoices.push(invoice);
    }
    if (broker && !row.brokers.some((b) => b.id === broker.id)) {
      row.brokers.push({ id: broker.id, name: broker.name, phone: broker.phone });
    }
  }

  const buyers = [...byBuyer.values()].sort((a, b) => b.outstanding - a.outstanding);
  const totalReceivable = buyers.reduce((s, b) => s + b.outstanding, 0);
  const totalOverdue = buyers.reduce((s, b) => s + b.overdueOutstanding, 0);
  const topPending = buyers.slice(0, 5).map((b) => ({ name: b.name, outstanding: b.outstanding }));

  return { asOf, buyers, totalReceivable, totalOverdue, topPending };
}

/**
 * One party's unsettled sale invoices, or null when nothing is outstanding.
 * Scoped query - the ledger page asks this per party, not for the whole book.
 */
export async function computePartyDues(partyId: string, asOf: Date = new Date()): Promise<BuyerDues | null> {
  const portfolio = await computeBuyerDues(asOf, { buyerId: partyId });
  return portfolio.buyers.find((b) => b.buyerId === partyId) ?? null;
}

/** Indian-grouped amount, e.g. 120000 → "1,20,000". */
function inr(n: number): string {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(n));
}

/** Compact ₹ (lakh/crore) for the owner digest, e.g. 1200000 → "₹12.0L". */
export function compactInr(n: number): string {
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(1)}Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(1)}L`;
  return `₹${inr(n)}`;
}

/**
 * One invoice per line, e.g.
 *   RVP/12/26-27 (₹1,20,000)
 *   RVP/15/26-27 (₹80,000)
 * Capped so a long book doesn't turn the reminder into a wall of text.
 *
 * NOTE: this rides in a WhatsApp template variable. Meta's Cloud API documents
 * that a body parameter may not contain newline characters, and no multi-line
 * variable has yet been delivered from this system - every previous one was
 * SKIPPED before reaching Fast2SMS. If a reminder starts failing with a
 * parameter-format error (#132000 / "parameter text cannot have new-line"),
 * this separator is the cause; switch it back to ' · ' and the send recovers.
 */
export function invoiceListText(invoices: InvoiceDue[], max = 10): string {
  if (invoices.length === 0) return '-';
  // Oldest due first - the order you'd chase them in. Sorted on a copy so the
  // caller's array (used for the totals) keeps its own order.
  const ordered = [...invoices].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  const shown = ordered.slice(0, max).map((i) => `${i.invoiceNumber} (₹${inr(i.outstanding)})`);
  if (ordered.length > max) shown.push(`+${ordered.length - max} more`);
  return shown.join('\n');
}

/** "Buyer A ₹12.0L · Buyer B ₹8.0L" for the owner digest. */
export function topPendingText(top: Array<{ name: string; outstanding: number }>): string {
  if (top.length === 0) return 'No pending dues 🎉';
  return top.map((t) => `${t.name} ${compactInr(t.outstanding)}`).join(' · ');
}
