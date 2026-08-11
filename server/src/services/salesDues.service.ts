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
 * dispatchDate) + order.dueDays.
 *
 * A shipment that has not been marked delivered has NO due date yet - the
 * dispatchDate fallback above is only a sort key, and reading it as a real due
 * date would say a lorry that left on the 8th with 1 credit day was overdue on
 * the 10th while it is still on the road. Such invoices are flagged `inTransit`
 * and are never `overdue`, which keeps the nightly buyer reminder (and the Party
 * Ledger's picker) from chasing money for goods the buyer has not received.
 * Same rule as the Sale Dues page.
 */

const TOLERANCE = 1; // sub-₹1 remainder is rounding noise - treat as settled

export interface InvoiceDue {
  dispatchId: string;
  invoiceNumber: string;
  outstanding: number;
  /** Placeholder while `inTransit` - only a sort key, not a real due date. */
  dueDate: Date;
  overdue: boolean;
  /** Dispatched but not yet marked delivered: billed, not yet collectable. */
  inTransit: boolean;
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
  inTransitOutstanding: number; // subset still on the road - owed, not yet collectable
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

    // Undelivered → the credit clock has not started. dueDate is computed off
    // dispatchDate purely so the row still sorts, and `overdue` is forced false.
    const inTransit = d.status !== 'DELIVERED';
    const base = d.deliveredDate ?? d.dispatchDate;
    const dueDate = addDays(base, order.dueDays ?? 0);
    const overdue = !inTransit && dueDate.getTime() < asOf.getTime();

    const buyer = order.buyer;
    let row = byBuyer.get(buyer.id);
    if (!row) {
      row = { buyerId: buyer.id, name: buyer.name, phone: buyer.phone, phone2: buyer.phone2, outstanding: 0, overdueOutstanding: 0, inTransitOutstanding: 0, invoices: [], overdueInvoices: [], brokers: [] };
      byBuyer.set(buyer.id, row);
    }
    const broker = order.broker && !isOwnBrokerName(order.broker.name) ? order.broker : null;
    const invoice: InvoiceDue = {
      dispatchId: d.id,
      invoiceNumber: d.invoiceNumber ?? `Dispatch ${d.id.slice(-6)}`,
      outstanding: Math.round(outstanding),
      dueDate,
      overdue,
      inTransit,
      brokerId: broker?.id ?? null,
    };
    row.outstanding += invoice.outstanding;
    row.invoices.push(invoice);
    if (overdue) {
      row.overdueOutstanding += invoice.outstanding;
      row.overdueInvoices.push(invoice);
    }
    if (inTransit) row.inTransitOutstanding += invoice.outstanding;
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
 * The due invoices as one comma-separated line, oldest due first - the order
 * you'd chase them in:
 *
 *   RVP/63/26-27 (₹1,75,279), RVP/64/26-27 (₹1,73,820)
 *
 * Deliberately ONE line. This rides in a WhatsApp template variable, and Meta's
 * Cloud API does not allow newline characters inside a parameter: a
 * newline-joined list was accepted by Fast2SMS and then dropped undelivered by
 * WhatsApp (Vimal Industries, 09:41 IST 09-Aug-2026). WhatsApp wraps the text
 * on the phone anyway, so a long list still reads over several lines.
 *
 * Sorted on a copy so the caller's array (used for the totals) keeps its order.
 */
export function invoiceListText(invoices: InvoiceDue[], max = 10): string {
  if (invoices.length === 0) return '-';
  const ordered = [...invoices].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  const shown = ordered.slice(0, max).map((i) => `${i.invoiceNumber} (₹${inr(i.outstanding)})`);
  if (ordered.length > max) shown.push(`+${ordered.length - max} more`);
  return shown.join(', ');
}

/** "Buyer A ₹12.0L · Buyer B ₹8.0L" for the owner digest. */
export function topPendingText(top: Array<{ name: string; outstanding: number }>): string {
  if (top.length === 0) return 'No pending dues 🎉';
  return top.map((t) => `${t.name} ${compactInr(t.outstanding)}`).join(' · ');
}
