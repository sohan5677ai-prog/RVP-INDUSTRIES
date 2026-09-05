import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { whatsappService } from './whatsapp.service.js';
import { computePartyDues, invoiceListText, isSameIstDay, type BuyerDues } from './salesDues.service.js';

/**
 * Which invoices a payment reminder should quote. The approved template says
 * "the due date has passed", so overdue and due-today invoices are used whenever there are
 * any; a party whose bills are all still inside their credit period is reported
 * as UPCOMING and reminded about the whole outstanding instead - the caller
 * shows/decides that distinction before anything is sent.
 */
export function duesScope(dues: BuyerDues, asOf: Date = new Date()) {
  const dueInvoices = dues.invoices.filter((i) => !i.inTransit && (i.overdue || isSameIstDay(i.dueDate, asOf)));
  if (dueInvoices.length > 0) {
    return {
      scope: 'OVERDUE' as const,
      invoices: dueInvoices,
      amount: dueInvoices.reduce((s, i) => s + i.outstanding, 0),
    };
  }
  // Nothing overdue → quote the bills still inside their credit period, but
  // leave out shipments still on the road: the buyer has not received those
  // goods, so a "please pay" default that includes them is a reminder we would
  // not want sent. They stay in the picker (the sender can tick them), just not
  // in the default scope.
  const upcoming = dues.invoices.filter((i) => !i.inTransit);
  if (upcoming.length > 0) {
    return {
      scope: 'UPCOMING' as const,
      invoices: upcoming,
      amount: upcoming.reduce((s, i) => s + i.outstanding, 0),
    };
  }
  // Every unsettled invoice is in transit - there is nothing to chase yet, but
  // the picker still needs a list to show.
  return { scope: 'UPCOMING' as const, invoices: dues.invoices, amount: dues.outstanding };
}

export interface PartyPaymentReminderResult {
  amount: number;
  invoiceCount: number;
  sent: { recipient: string; phone: string | null; amount: number; invoices: number }[];
  failed: { recipient: string; error: string }[];
}

/**
 * Core of the Party Ledger "Payment Reminder" send - who gets messaged and what
 * they're told. Shared by the manual dialog (whatsapp.controller.ts
 * `sendPartyPaymentReminder`) and the automated per-party schedule sweep
 * (whatsappJobs.ts `runPartyReminderSchedulesSweep`), so a scheduled send goes
 * out identically to a manual click with no invoices pre-selected.
 *
 * Throws HttpError for conditions the caller can't route around (party not
 * found, nothing outstanding, bad target/broker selection). A partial send
 * (e.g. one broker has no phone on file) is reported in `failed` instead,
 * since the other legs may have gone out fine.
 */
export async function runPartyPaymentReminderCore(
  partyId: string,
  opts: { target?: string; dispatchIds?: string[]; brokerIds?: string[] } = {},
): Promise<PartyPaymentReminderResult> {
  const target = (opts.target ?? 'PARTY').toUpperCase();
  if (!['PARTY', 'BROKER', 'BOTH'].includes(target)) {
    throw new HttpError(400, `Unknown reminder target "${opts.target}" - expected PARTY, BROKER or BOTH`);
  }

  const party = await prisma.party.findUnique({ where: { id: partyId } });
  if (!party) throw new HttpError(404, 'Party not found');

  const dues = await computePartyDues(party.id);
  if (!dues || dues.invoices.length === 0) {
    throw new HttpError(400, `${party.name} has no outstanding sale invoices - nothing to remind about`);
  }

  let active: { invoices: typeof dues.invoices; amount: number };
  if (opts.dispatchIds) {
    const picked = dues.invoices.filter((i) => opts.dispatchIds!.includes(i.dispatchId));
    if (picked.length === 0) throw new HttpError(400, 'Select at least one invoice to remind about');
    active = { invoices: picked, amount: picked.reduce((s, i) => s + i.outstanding, 0) };
  } else {
    active = duesScope(dues);
  }

  const sent: PartyPaymentReminderResult['sent'] = [];
  const failed: PartyPaymentReminderResult['failed'] = [];

  // The office is copied on this reminder, but ONCE per send. A "both" send is
  // one act of chasing, not two: the first leg to actually go out carries the
  // internal copy, and the broker legs after it do not repeat it.
  let internalCopyDone = false;

  if (target === 'PARTY' || target === 'BOTH') {
    if (!party.phone && !party.phone2) {
      failed.push({ recipient: party.name, error: 'No phone number on file - add one in Parties first' });
    } else {
      const result = await whatsappService.sendPaymentReminder({
        recipientName: party.name,
        phones: [party.phone, party.phone2],
        outstanding: active.amount,
        invoiceListText: invoiceListText(active.invoices),
        buyerId: party.id,
        language: party.waLanguage,
        internalCopy: true,
      });
      internalCopyDone = true;
      if (result.ok) sent.push({ recipient: party.name, phone: party.phone ?? party.phone2, amount: active.amount, invoices: active.invoices.length });
      else failed.push({ recipient: party.name, error: result.error ?? 'WhatsApp send failed' });
    }
  }

  if (target === 'BROKER' || target === 'BOTH') {
    // An explicit brokerIds list narrows the copy; without one every broker
    // behind the due invoices is copied. A broker whose invoices all fall
    // OUTSIDE the active scope (brokered a bill that isn't overdue yet, while
    // others are) has nothing to be told about, so drop them here rather than
    // silently skipping later and reporting an empty failure.
    const selected = opts.brokerIds?.length ? dues.brokers.filter((b) => opts.brokerIds!.includes(b.id)) : dues.brokers;
    const wanted = selected.filter((b) => active.invoices.some((i) => i.brokerId === b.id));
    if (wanted.length === 0) {
      const reason = dues.brokers.length === 0
        ? 'No broker on these invoices (own orders) - send to the party instead'
        : selected.length === 0
          ? 'None of the selected brokers are on these invoices'
          : `No selected invoice is on these brokers' orders`;
      if (target === 'BROKER') throw new HttpError(400, reason);
      failed.push({ recipient: 'Broker', error: reason });
    }
    for (const broker of wanted) {
      const theirs = active.invoices.filter((i) => i.brokerId === broker.id);
      if (!broker.phone) {
        failed.push({ recipient: broker.name, error: 'No phone number on file for this broker' });
        continue;
      }
      const amount = theirs.reduce((s, i) => s + i.outstanding, 0);
      const result = await whatsappService.sendPaymentReminder({
        recipientName: `${broker.name} (for ${party.name})`,
        phones: [broker.phone],
        outstanding: amount,
        invoiceListText: invoiceListText(theirs),
        buyerId: party.id,
        // The broker's own language, not the buyer's - it is the broker reading it.
        language: broker.waLanguage,
        internalCopy: !internalCopyDone,
      });
      internalCopyDone = true;
      if (result.ok) sent.push({ recipient: broker.name, phone: broker.phone, amount, invoices: theirs.length });
      else failed.push({ recipient: broker.name, error: result.error ?? 'WhatsApp send failed' });
    }
  }

  if (sent.length === 0) {
    throw new HttpError(502, failed[0]?.error ?? 'WhatsApp send failed');
  }

  return { amount: active.amount, invoiceCount: active.invoices.length, sent, failed };
}
