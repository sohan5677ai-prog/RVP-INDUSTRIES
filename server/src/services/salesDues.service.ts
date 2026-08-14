import type { SaleProduct, WaLanguage } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { istCalendar } from '../lib/istDate.js';

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
  /** Broker's display name - null for our own orders. Denormalised here because
   *  the owner "due today" digest spans every buyer, unlike the per-buyer lists
   *  below that already have their buyer/broker in scope. */
  brokerName: string | null;
  buyerName: string;
  /** Full billed value (base + GST), whole rupees - lets a caller show "partially paid" vs the outstanding balance. */
  billAmount: number;
  billDate: Date;
  product: SaleProduct;
  vehicleNumber: string | null;
  /** Days past due, 0 while `inTransit` (the clock hasn't started) or not yet due. */
  dueDaysAfter: number;
  /** The order's credit term (days from delivery) - what an in-transit row's due date will be measured from. */
  dueDays: number;
  /** Some, but not all, of the bill has been cleared. */
  partiallyPaid: boolean;
}

/** A broker standing behind at least one of a buyer's unsettled invoices. */
export interface DuesBroker {
  id: string;
  name: string;
  phone: string | null;
  /** The broker's OWN language - a broker copy is read by the broker, not the buyer. */
  waLanguage?: WaLanguage | null;
}

export interface BuyerDues {
  buyerId: string;
  name: string;
  phone: string | null;
  phone2?: string | null;
  /** Language the dues reminder goes out in - see Party.waLanguage. */
  waLanguage?: WaLanguage | null;
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
  /** Buyers with the largest OVERDUE (past due date) balance, most first - excludes buyers with nothing yet overdue. */
  topPending: Array<{ name: string; outstanding: number }>;
  /** Every invoice whose due date IS today (IST calendar day), across all buyers - the owner "due today" digest. */
  dueToday: InvoiceDue[];
  totalDueToday: number;
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

/** Same IST calendar day, not the same 24h window - a due date at 00:05 IST and `asOf` at 23:50 IST are still "today". */
function isSameIstDay(a: Date, b: Date): boolean {
  const pa = istCalendar(a);
  const pb = istCalendar(b);
  return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
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
          buyer: { select: { id: true, name: true, phone: true, phone2: true, waLanguage: true } },
          broker: { select: { id: true, name: true, phone: true, waLanguage: true } },
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
    const dueDaysAfter = overdue ? Math.max(0, Math.ceil((asOf.getTime() - dueDate.getTime()) / 86400000)) : 0;

    const buyer = order.buyer;
    let row = byBuyer.get(buyer.id);
    if (!row) {
      row = { buyerId: buyer.id, name: buyer.name, phone: buyer.phone, phone2: buyer.phone2, waLanguage: buyer.waLanguage, outstanding: 0, overdueOutstanding: 0, inTransitOutstanding: 0, invoices: [], overdueInvoices: [], brokers: [] };
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
      brokerName: broker?.name ?? null,
      buyerName: buyer.name,
      billAmount: invoiceValue,
      billDate: d.dispatchDate,
      product: order.product,
      vehicleNumber: d.vehicleNumber ?? null,
      dueDaysAfter,
      dueDays: order.dueDays ?? 0,
      partiallyPaid: cleared > 0.01,
    };
    row.outstanding += invoice.outstanding;
    row.invoices.push(invoice);
    if (overdue) {
      row.overdueOutstanding += invoice.outstanding;
      row.overdueInvoices.push(invoice);
    }
    if (inTransit) row.inTransitOutstanding += invoice.outstanding;
    if (broker && !row.brokers.some((b) => b.id === broker.id)) {
      row.brokers.push({ id: broker.id, name: broker.name, phone: broker.phone, waLanguage: broker.waLanguage });
    }
  }

  const buyers = [...byBuyer.values()].sort((a, b) => b.outstanding - a.outstanding);
  const totalReceivable = buyers.reduce((s, b) => s + b.outstanding, 0);
  const totalOverdue = buyers.reduce((s, b) => s + b.overdueOutstanding, 0);
  const topPending = buyers
    .filter((b) => b.overdueOutstanding > 0)
    .sort((a, b) => b.overdueOutstanding - a.overdueOutstanding)
    .map((b) => ({ name: b.name, outstanding: b.overdueOutstanding }));

  const dueToday = buyers
    .flatMap((b) => b.invoices)
    .filter((i) => !i.inTransit && isSameIstDay(i.dueDate, asOf))
    .sort((a, b) => b.outstanding - a.outstanding);
  const totalDueToday = dueToday.reduce((s, i) => s + i.outstanding, 0);

  return { asOf, buyers, totalReceivable, totalOverdue, topPending, dueToday, totalDueToday };
}

// Byproducts share one tab on the Sale Dues page - mirrors
// client/src/pages/SaleDues.tsx (BYPRODUCT_PRODUCTS / matchesProductFilter).
const BYPRODUCT_PRODUCTS: SaleProduct[] = ['WASTE', 'SHELL', 'PRECLEANER_DUST', 'NALLA_POKKULU', 'NALLA_CHINTAPANDU'];

function matchesProductFilter(product: SaleProduct, filter: string): boolean {
  if (!filter || filter === 'ALL') return true;
  if (filter === 'BYPRODUCTS') return BYPRODUCT_PRODUCTS.includes(product);
  return product === filter;
}

/** A lorry number reduced to its letters and digits - mirrors the page's `plate()`,
 *  so a search for "AP39T1234" still finds a plate recorded as "AP 39 T 1234". */
function plate(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** IST calendar YYYY-MM for a due date - the "Due Month" filter buckets on this,
 *  never process-local time (the server runs UTC on Render). */
function istMonthKey(d: Date): string {
  const c = istCalendar(d);
  return `${c.year}-${String(c.month).padStart(2, '0')}`;
}

/** IST calendar YYYY-MM-DD - sortable/comparable as plain strings. */
function istDateKey(d: Date): string {
  const c = istCalendar(d);
  return `${c.year}-${String(c.month).padStart(2, '0')}-${String(c.day).padStart(2, '0')}`;
}

export interface DuesFilterOptions {
  /** SaleProduct enum value, 'BYPRODUCTS', or 'ALL'/undefined for no filter. */
  product?: string;
  /** 'YYYY-MM' (IST, matched against due date) or 'ALL'/undefined for every month. */
  month?: string;
  /** Buyer name, invoice number, or lorry plate (letters/digits only). */
  search?: string;
  /** Bill-date window, inclusive, 'YYYY-MM-DD'. */
  billFrom?: string;
  billTo?: string;
}

/**
 * Narrows a portfolio to what the Sale Dues page's filters would show, with
 * every buyer-level total (outstanding/overdue/in-transit) recomputed from the
 * surviving invoices - so a filtered PDF's group bands and summary strip add
 * up to the rows actually printed, not the party's full unfiltered book.
 * Mirrors the page's `matchesProductFilter` / month bucketing / search exactly,
 * so the "Download PDF" button on that page always matches what's on screen.
 */
export function filterDuesPortfolio(portfolio: DuesPortfolio, opts: DuesFilterOptions): DuesPortfolio {
  const product = opts.product || 'ALL';
  const month = opts.month || 'ALL';
  const search = (opts.search || '').trim().toLowerCase();
  const plateQuery = plate(search);

  const buyers = portfolio.buyers
    .map((b): BuyerDues | null => {
      const invoices = b.invoices.filter((inv) => {
        if (!matchesProductFilter(inv.product, product)) return false;
        // Same rule as the page: an in-transit invoice has no real due date, so
        // it drops out under any specific due-month filter (stays under "All").
        if (month !== 'ALL' && (inv.inTransit || istMonthKey(inv.dueDate) !== month)) return false;
        if (search) {
          const hit =
            b.name.toLowerCase().includes(search) ||
            inv.invoiceNumber.toLowerCase().includes(search) ||
            (!!plateQuery && plate(inv.vehicleNumber).includes(plateQuery));
          if (!hit) return false;
        }
        const billKey = istDateKey(inv.billDate);
        if (opts.billFrom && billKey < opts.billFrom) return false;
        if (opts.billTo && billKey > opts.billTo) return false;
        return true;
      });
      if (invoices.length === 0) return null;
      return {
        ...b,
        invoices,
        overdueInvoices: invoices.filter((i) => i.overdue),
        outstanding: invoices.reduce((s, i) => s + i.outstanding, 0),
        overdueOutstanding: invoices.filter((i) => i.overdue).reduce((s, i) => s + i.outstanding, 0),
        inTransitOutstanding: invoices.filter((i) => i.inTransit).reduce((s, i) => s + i.outstanding, 0),
      };
    })
    .filter((b): b is BuyerDues => b !== null)
    .sort((a, b) => b.outstanding - a.outstanding);

  return {
    ...portfolio,
    buyers,
    totalReceivable: buyers.reduce((s, b) => s + b.outstanding, 0),
    totalOverdue: buyers.reduce((s, b) => s + b.overdueOutstanding, 0),
  };
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

/** "Buyer A ₹12.0L · Buyer B ₹8.0L" for the owner digest - overdue buyers only. */
export function topPendingText(top: Array<{ name: string; outstanding: number }>): string {
  if (top.length === 0) return 'No overdue dues 🎉';
  return top.map((t) => `${t.name} ${compactInr(t.outstanding)}`).join(' · ');
}

/**
 * The "due today" list as one comma-separated line for the owner digest -
 * INVOICE ₹AMOUNT - BUYER (via BROKER | direct). Same one-line constraint as
 * `invoiceListText` (see docs/whatsapp-payment-reminder-templates.md) - Meta
 * drops any template variable containing a newline. Largest amount first,
 * since that's the bill an owner would chase first.
 */
export function dueTodayListText(invoices: InvoiceDue[], max = 10): string {
  if (invoices.length === 0) return '-';
  const shown = invoices.slice(0, max).map((i) => {
    const broker = i.brokerName ? `via ${i.brokerName}` : 'direct';
    return `${i.invoiceNumber} ₹${inr(i.outstanding)} - ${i.buyerName} (${broker})`;
  });
  if (invoices.length > max) shown.push(`+${invoices.length - max} more`);
  return shown.join(', ');
}
