import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { HttpError } from '../lib/httpError.js';
import { whatsappService, resolveInternalCopyRecipients } from './whatsapp.service.js';
import { buildInvoicePdfData } from './saleDocumentEmail.service.js';
import { TaxproService } from './taxpro.service.js';
import { renderInvoicePdf } from '../lib/invoicePdf.js';
import { renderEwbPdf } from '../lib/ewbPdf.js';
import { renderLorryReceiptPdf } from '../lib/lorryReceiptPdf.js';
import { qrPngBuffer } from '../lib/qrcode.js';
import { mergePdfs } from '../lib/pdfMerge.js';
import { uploadFileToStorage } from '../lib/upload.js';
import { ensureLorryReceiptAssigned } from '../controllers/sale.controller.js';
import { clearCache } from '../lib/cache.js';

/** One recipient's outcome, plus why it didn't land when it didn't. */
export type DispatchWhatsAppLeg = {
  status: 'sent' | 'skipped' | 'failed' | 'na';
  error: string | null;
};

export type DispatchWhatsAppResult = {
  ok: boolean;
  party: DispatchWhatsAppLeg;
  broker: DispatchWhatsAppLeg;
  driver: DispatchWhatsAppLeg;
  internal: DispatchWhatsAppLeg;
};

/**
 * Page 2 of the bundle: the **official** government-format E-Way Bill, fetched
 * from TaxPro's ASP print service (`printdetailewb`) - the same document the EWB
 * portal issues, which is what a checkpost officer expects to be shown. Our
 * in-house `renderEwbPdf` replica is only the fallback.
 *
 * Two things make that endpoint unlike the rest of the integration: it lives on
 * TaxPro's PRODUCTION host even while `taxproSandbox` is on (sandbox answers
 * `GSP503: This feature is available only in Production`), and it is a pure
 * renderer of the record we POST rather than a NIC lookup.
 *
 * Being a network call, it can fail - and by then the E-Way Bill already exists
 * at NIC, so failing the send would cost the buyer their paperwork over a print
 * hiccup. Fall back to the replica and log it rather than throwing.
 */
async function renderBundleEwbPdf(
  dispatch: Awaited<ReturnType<typeof buildInvoicePdfData>>['dispatch'],
  order: Awaited<ReturnType<typeof buildInvoicePdfData>>['order'],
  company: Awaited<ReturnType<typeof buildInvoicePdfData>>['company'],
  pdfData: Awaited<ReturnType<typeof buildInvoicePdfData>>['pdfData'],
): Promise<Buffer> {
  try {
    return await TaxproService.printEWayBillDetailPdf(dispatch.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[dispatch-whatsapp] official EWB print failed for ${dispatch.ewbNumber} - attaching the in-house replica instead: ${message}`,
    );
    return renderEwbPdf({
      company: { ...pdfData.company, pincode: company.pincode },
      buyer: { ...pdfData.buyer, pincode: order.buyer.pincode },
      dispatchFrom: {
        place: company.dispatchFromPlace,
        address1: company.dispatchFromAddress1,
        address2: company.dispatchFromAddress2,
        pincode: company.dispatchFromPincode,
      },
      shipToPlace: order.buyer.city,
      transport: {
        transMode: dispatch.ewbTransMode,
        transDocNo: dispatch.ewbTransDocNo,
        transDocDate: dispatch.ewbTransDocDate,
      },
      invoiceNumber: pdfData.invoiceNumber,
      invoiceDate: pdfData.invoiceDate,
      vehicleNumber: pdfData.vehicleNumber,
      line: pdfData.line,
      gstRate: pdfData.gstRate,
      ewbNumber: dispatch.ewbNumber!,
      ewbDate: dispatch.ewbDate!,
      ewbValidUpto: dispatch.ewbValidUpto!,
      ewbDistance: dispatch.ewbDistance,
      dispatchDate: dispatch.dispatchDate,
      qrPngBuffer: await qrPngBuffer(dispatch.ewbNumber!),
    });
  }
}

/**
 * The dispatch bundle for one lorry: the buyer (and the broker, when the order
 * came through a real one) gets the tax-invoice PDF - with the E-Way Bill merged
 * onto it when one exists - plus the driver's details. The driver himself is
 * messaged at dispatch time, not here; his leg in the result is read back from
 * the log so the caller still sees all three outcomes.
 *
 * Shared by the manual "Send via WhatsApp" button and the automatic send that
 * follows a combined IRN + E-Way Bill generation. Requires the tax invoice to be
 * raised first (buildInvoicePdfData enforces that).
 *
 * Never throws on a send failure: each leg is independent and reports itself, so
 * one missing phone can't suppress the others.
 */
export async function sendDispatchBundleWhatsApp(dispatchId: string): Promise<DispatchWhatsAppResult> {
  const { dispatch, order, company, pdfData } = await buildInvoicePdfData(dispatchId);

  // A broker named "RVP" (or no broker) means it's our own order - the buyer is
  // messaged directly with no broker reference; otherwise the buyer's copy names
  // the broker and the broker gets their own greeting copy.
  const broker = order.brokerId
    ? await prisma.broker.findUnique({ where: { id: order.brokerId } })
    : null;
  const isOwnBroker = !broker || broker.name.trim().toUpperCase() === 'RVP';
  const brokerName = isOwnBroker ? null : broker!.name;

  // A WhatsApp template message carries only ONE document. So when an E-Way Bill
  // exists, render it too and MERGE it onto the tax invoice, producing a single
  // combined PDF (invoice pages + EWB page) for the template's document header.
  const invoiceBuffer = await renderInvoicePdf(pdfData);
  const hasEwb = !!(dispatch.ewbNumber && dispatch.ewbDate && dispatch.ewbValidUpto);
  // Page 2 is an official E-Way Bill: without a recorded distance it would go to
  // the buyer showing 0 KM. Stop here rather than send an invalid document - the
  // caller surfaces this, the distance gets saved, and the bundle is re-sent.
  if (hasEwb && !dispatch.ewbDistance) {
    throw new Error(
      `E-Way Bill ${dispatch.ewbNumber} has no approx distance recorded - the attached bill would show 0 KM. ` +
      `Save the distance on the E-Way Bill page, then send the bundle again.`,
    );
  }
  const pages = [invoiceBuffer];
  const parts = ['Invoice'];
  if (hasEwb) {
    const ewbBuffer = await renderBundleEwbPdf(dispatch, order, company, pdfData);
    pages.push(ewbBuffer);
    parts.push('EWB');
  }
  // Page 3, for buyers switched on for it in Parties: the Surya Road Lines lorry
  // receipt (GC note). Assigning the GC number here (idempotent - a shipment
  // that already has one keeps it) is what "generates" the lorry receipt as
  // part of raising the invoice, same as the IRN/EWB above.
  if (order.buyer.lorryReceiptEnabled) {
    const lrDispatch = await ensureLorryReceiptAssigned(dispatch.id);
    clearCache('sale-orders');
    if (lrDispatch?.lrNumber) {
      const lrBuffer = await renderLorryReceiptPdf({
        company: {
          name: company.name,
          address: company.address,
          dispatchFromPlace: company.dispatchFromPlace,
          stateName: company.stateName,
        },
        buyer: {
          name: order.buyer.name,
          address: order.buyer.address,
          city: order.buyer.city,
          state: order.buyer.state,
          pincode: order.buyer.pincode,
        },
        destination: order.destination,
        product: order.product,
        invoiceNumber: dispatch.invoiceNumber,
        vehicleNumber: dispatch.vehicleNumber,
        driverName: dispatch.driverName,
        weightKg: dispatch.weightKg,
        gcNo: lrDispatch.lrNumber,
        gcDate: lrDispatch.lrDate ?? dispatch.invoiceDate ?? dispatch.dispatchDate,
        bags: lrDispatch.lrBags,
        kgPerBag: lrDispatch.lrKgPerBag,
      });
      pages.push(lrBuffer);
      parts.push('LR');
    }
  }
  const buffer = pages.length > 1 ? await mergePdfs(pages) : pages[0];
  const filename = parts.length > 1
    ? `${parts.join('-')}-${dispatch.invoiceNumber!.replace(/\//g, '-')}.pdf`
    : `${dispatch.invoiceNumber!.replace(/\//g, '-')}.pdf`;
  // Park the (combined) PDF in Supabase Storage so Fast2SMS can fetch it as the
  // template's document header.
  const documentUrl = await uploadFileToStorage({
    originalname: filename,
    mimetype: 'application/pdf',
    buffer,
  } as Express.Multer.File);

  // Each leg reports its own status AND the reason it didn't land, so the UI can
  // say "Broker skipped - no phone number on file" instead of a bare "skipped".
  const leg = (r: { ok: boolean; skipped?: boolean; error?: string }): DispatchWhatsAppLeg => ({
    status: r.ok ? 'sent' : r.skipped ? 'skipped' : 'failed',
    error: r.ok ? null : r.error ?? null,
  });

  // Party (buyer) - always. Includes the broker reference when there's a real broker.
  const buyerPhones = [order.buyer.phone, order.buyer.phone2].filter(Boolean) as string[];
  const partyResult = buyerPhones.length > 0
    ? await whatsappService.sendDispatchToParty({
        dispatchId: dispatch.id,
        buyerName: order.buyer.name,
        orderRef: dispatch.invoiceNumber!,
        vehicleNumber: dispatch.vehicleNumber,
        quantityKg: dispatch.weightKg,
        driverName: dispatch.driverName,
        driverPhone: dispatch.driverPhone,
        brokerName,
        documentUrl,
        documentFilename: filename,
        toPhone: buyerPhones,
      })
    : { ok: false, skipped: true, error: `${order.buyer.name} has no phone number on file` };

  // Broker - only when the order came through a real broker with a phone on file.
  let brokerResult: { ok: boolean; skipped?: boolean; error?: string } | null = null;
  if (brokerName && broker?.phone) {
    brokerResult = await whatsappService.sendDispatchBundle({
      dispatchId: dispatch.id,
      recipientName: broker.name,
      buyerName: order.buyer.name,
      orderRef: dispatch.invoiceNumber!,
      vehicleNumber: dispatch.vehicleNumber,
      quantityKg: dispatch.weightKg,
      driverName: dispatch.driverName,
      driverPhone: dispatch.driverPhone,
      documentUrl,
      documentFilename: filename,
      toPhone: broker.phone,
    });
  } else if (brokerName && !broker?.phone) {
    brokerResult = { ok: false, skipped: true, error: `${broker!.name} has no phone number on file` };
  }

  // Driver - NOT sent from here. He already got the buyer's name, phone and maps
  // link the moment the dispatch was created (createDispatch in sale.controller),
  // which is when he actually needs them; the invoice bundle runs hours later,
  // once the IRN/EWB exist. Sending again here only duplicated the message and
  // billed a second WhatsApp conversation. Report that earlier send instead, so
  // the toast still accounts for all three legs.
  const driverLeg = await driverLegFromLog(dispatch.id, dispatch.driverPhone);

  // Internal copy - every member in Settings → "Dispatch & alert recipients" gets
  // the very same paperwork the buyer got: the buyer's template, the buyer's
  // wording, the combined Invoice + EWB PDF. It's the office's own record of what
  // went out, so it deliberately mirrors the party copy rather than reading as an alert.
  const internalResult = await sendInternalCopy({
    dispatchId: dispatch.id,
    buyerName: order.buyer.name,
    orderRef: dispatch.invoiceNumber!,
    vehicleNumber: dispatch.vehicleNumber,
    quantityKg: dispatch.weightKg,
    driverName: dispatch.driverName,
    driverPhone: dispatch.driverPhone,
    brokerName,
    documentUrl,
    documentFilename: filename,
    alreadyMessaged: [...buyerPhones, broker?.phone ?? null],
  });

  return {
    ok: partyResult.ok || !!brokerResult?.ok,
    party: leg(partyResult),
    broker: brokerResult ? leg(brokerResult) : { status: 'na', error: null },
    driver: driverLeg,
    internal: internalResult ? leg(internalResult) : { status: 'na', error: null },
  };
}

/**
 * The internal copy of the party bundle, sent to every member configured in
 * Company Settings → "Dispatch & alert recipients" (falling back to the single
 * owner number when that list is empty). Members already on the buyer's or
 * broker's row are dropped - they've had the bundle once already. Returns null -
 * reported as `na` - when that leaves nobody to copy. One aggregate leg is
 * reported for the whole list: `sent` if it reached at least one member.
 */
async function sendInternalCopy(args: {
  dispatchId: string;
  buyerName: string;
  orderRef: string;
  vehicleNumber: string | null;
  quantityKg: number | null;
  driverName: string | null;
  driverPhone: string | null;
  brokerName: string | null;
  documentUrl: string;
  documentFilename: string;
  alreadyMessaged: Array<string | null>;
}): Promise<{ ok: boolean; skipped?: boolean; error?: string } | null> {
  const targets = await resolveInternalCopyRecipients(args.alreadyMessaged);
  if (targets.length === 0) return null;

  const { alreadyMessaged: _ignored, ...bundle } = args;
  const results = await Promise.all(
    targets.map((toPhone) => whatsappService.sendDispatchToParty({ ...bundle, toPhone })),
  );
  const anyOk = results.some((r) => r.ok);
  if (anyOk) return { ok: true };
  return {
    ok: false,
    skipped: results.every((r) => r.skipped),
    error: results.find((r) => r.error)?.error,
  };
}

/**
 * The driver leg's outcome, read back from WhatsAppLog rather than re-sent.
 * Reflects delivery-status callbacks too: a message Meta later rejected has been
 * flipped to FAILED by the webhook, so a bundle sent afterwards reports the
 * failure rather than the optimistic "sent" from the send call.
 */
async function driverLegFromLog(dispatchId: string, driverPhone: string | null): Promise<DispatchWhatsAppLeg> {
  if (!driverPhone) return { status: 'skipped', error: 'No driver phone on this dispatch' };
  const row = await prisma.whatsAppLog.findFirst({
    where: {
      direction: 'OUTBOUND',
      template: 'DISPATCH_DRIVER',
      relatedType: 'DISPATCH',
      relatedId: dispatchId,
    },
    orderBy: { createdAt: 'desc' },
    select: { status: true, errorMessage: true },
  });
  if (!row) {
    return { status: 'skipped', error: 'No driver message on record - the driver is messaged when the dispatch is created' };
  }
  if (row.status === 'SENT') return { status: 'sent', error: null };
  return { status: row.status === 'SKIPPED' ? 'skipped' : 'failed', error: row.errorMessage ?? null };
}

/**
 * Re-fire just the driver leg for an existing dispatch - used by the "Resend
 * to driver" button and for testing the Location-header send (see
 * whatsapp.service.ts notifyDispatchDriver) against Settings -> WhatsApp's
 * test number without creating a new dispatch. Safe to call repeatedly: it
 * only sends and logs, no business state changes.
 */
export async function resendDispatchDriverWhatsApp(dispatchId: string): Promise<DispatchWhatsAppLeg> {
  const dispatch = await prisma.saleDispatch.findUnique({
    where: { id: dispatchId },
    include: { saleOrder: { include: { buyer: true } } },
  });
  if (!dispatch) throw new HttpError(404, 'Dispatch not found');
  if (!dispatch.driverPhone) throw new HttpError(400, 'This dispatch has no driver phone on file');

  const buyer = dispatch.saleOrder.buyer;
  const result = await whatsappService.notifyDispatchDriver(
    { id: dispatch.id, vehicleNumber: dispatch.vehicleNumber, driverPhone: dispatch.driverPhone },
    { name: buyer.name, phone: buyer.phone, locationLink: buyer.locationLink, address: buyer.address, city: buyer.city },
  );
  return {
    status: result?.ok ? 'sent' : result?.skipped ? 'skipped' : 'failed',
    error: result?.ok ? null : result?.error ?? null,
  };
}
