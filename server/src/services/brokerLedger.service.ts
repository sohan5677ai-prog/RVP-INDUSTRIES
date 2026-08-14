import { prisma } from '../lib/prisma.js';
import type { WaLanguage } from '@prisma/client';

/**
 * Flat brokerage per dispatched sale order, and the "RVP" own-orders marker -
 * duplicated from `client/src/pages/BrokerageLedger.tsx` (also mirrored in
 * `dashboard.controller.ts`) rather than shared, matching how this constant
 * already lives in three places across the app. Keep all four in step if the
 * flat rate ever changes.
 */
const FLAT_BROKERAGE = 2000;

export const isOwnBroker = (name?: string | null) => (name ?? '').trim().toUpperCase() === 'RVP';

export interface BrokerLedgerTxn {
  id: string;
  date: string; // ISO
  kind: 'BROKERAGE' | 'PAYMENT';
  particulars: string;
  invoiceNumber: string | null;
  vehicleNumber: string | null;
  reference: string | null;
  debit: number;
  credit: number;
  runningBalance: number;
}

export interface BrokerLedgerData {
  broker: { id: string; name: string; phone: string | null; waLanguage: WaLanguage };
  transactions: BrokerLedgerTxn[];
}

/**
 * Build a broker's full brokerage ledger (one BROKERAGE line per dispatched
 * sale order under them, one PAYMENT line per `Payment` row of type BROKER),
 * sorted chronologically with a running balance - the same Dr/Cr mechanics as
 * `BrokerageLedger.tsx`'s `allTxns`, ported server-side so the WhatsApp send
 * and the PDF read from one source of truth instead of re-deriving the page's
 * client-only computation. Returns null when the broker doesn't exist.
 */
export async function buildBrokerLedgerData(brokerId: string): Promise<BrokerLedgerData | null> {
  const broker = await prisma.broker.findUnique({ where: { id: brokerId } });
  if (!broker) return null;

  const [saleOrders, payments] = await Promise.all([
    prisma.saleOrder.findMany({
      where: { brokerId },
      include: { dispatches: true, buyer: { select: { name: true } } },
    }),
    prisma.payment.findMany({ where: { type: 'BROKER', brokerId } }),
  ]);

  const lines: Omit<BrokerLedgerTxn, 'runningBalance'>[] = [];

  for (const o of saleOrders) {
    for (const d of o.dispatches) {
      lines.push({
        id: `BROKERAGE-${d.id}`,
        date: d.dispatchDate.toISOString(),
        kind: 'BROKERAGE',
        particulars: `Brokerage - Sale to ${o.buyer?.name ?? '-'}`,
        invoiceNumber: d.invoiceNumber,
        vehicleNumber: d.vehicleNumber,
        reference: null,
        debit: 0,
        credit: FLAT_BROKERAGE,
      });
    }
  }

  for (const p of payments) {
    lines.push({
      id: `PAYMENT-${p.id}`,
      date: p.date.toISOString(),
      kind: 'PAYMENT',
      particulars: 'Payment',
      invoiceNumber: null,
      vehicleNumber: null,
      reference: p.reference ?? p.description ?? null,
      debit: Number(p.amount),
      credit: 0,
    });
  }

  lines.sort((a, c) => new Date(a.date).getTime() - new Date(c.date).getTime());

  let running = 0;
  const transactions = lines.map((l) => {
    running += l.debit - l.credit;
    return { ...l, runningBalance: running };
  });

  return { broker, transactions };
}
