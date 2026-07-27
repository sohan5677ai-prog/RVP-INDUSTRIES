import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { whatsappService } from './whatsapp.service.js';
import { buildInvoicePdfData } from './saleDocumentEmail.service.js';
import { TaxproService } from './taxpro.service.js';
import { renderInvoicePdf } from '../lib/invoicePdf.js';
import { renderEwbPdf } from '../lib/ewbPdf.js';
import { qrPngBuffer } from '../lib/qrcode.js';
import { mergePdfs } from '../lib/pdfMerge.js';
import { uploadFileToStorage } from '../lib/upload.js';

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
};

/**
 * Page 2 of the bundle: the **official** government-format E-Way Bill, fetched
 * from TaxPro's ASP print service (`printdetailewb`) — the same document the EWB
 * portal issues, which is what a checkpost officer expects to be shown. Our
 * in-house `renderEwbPdf` replica is only the fallback.
 *
 * Two things make that endpoint unlike the rest of the integration: it lives on
 * TaxPro's PRODUCTION host even while `taxproSandbox` is on (sandbox answers
 * `GSP503: This feature is available only in Production`), and it is a pure
 * renderer of the record we POST rather than a NIC lookup.
 *
 * Being a network call, it can fail — and by then the E-Way Bill already exists
 * at NIC, so failing the send would cost the buyer their paperwork over a print
 * hiccup. Fall back to the replica and log it rather than throwing.
 */
async function renderBundleEwbPdf(
  dispatch: Awaited<ReturnType<typeof buildInvoicePdfData>>['dispatch'],
  pdfData: Awaited<ReturnType<typeof buildInvoicePdfData>>['pdfData'],
): Promise<Buffer> {
  try {
    return await TaxproService.printEWayBillDetailPdf(dispatch.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[dispatch-whatsapp] official EWB print failed for ${dispatch.ewbNumber} — attaching the in-house replica instead: ${message}`,
    );
    return renderEwbPdf({
      company: pdfData.company,
      buyer: pdfData.buyer,
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
 * came through a real one) gets the tax-invoice PDF — with the E-Way Bill merged
 * onto it when one exists — plus the driver's details; the driver separately gets
 * the buyer's name/phone/maps link on his own template.
 *
 * Shared by the manual "Send via WhatsApp" button and the automatic send that
 * follows a combined IRN + E-Way Bill generation. Requires the tax invoice to be
 * raised first (buildInvoicePdfData enforces that).
 *
 * Never throws on a send failure: each leg is independent and reports itself, so
 * one missing phone can't suppress the others.
 */
export async function sendDispatchBundleWhatsApp(dispatchId: string): Promise<DispatchWhatsAppResult> {
  const { dispatch, order, pdfData } = await buildInvoicePdfData(dispatchId);

  // A broker named "RVP" (or no broker) means it's our own order — the buyer is
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
  let buffer = invoiceBuffer;
  let filename = `${dispatch.invoiceNumber!.replace(/\//g, '-')}.pdf`;
  if (hasEwb) {
    const ewbBuffer = await renderBundleEwbPdf(dispatch, pdfData);
    buffer = await mergePdfs([invoiceBuffer, ewbBuffer]);
    filename = `Invoice-EWB-${dispatch.invoiceNumber!.replace(/\//g, '-')}.pdf`;
  }
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

  // Party (buyer) — always. Includes the broker reference when there's a real broker.
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

  // Broker — only when the order came through a real broker with a phone on file.
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

  // Driver — best-effort, independent of the above; its own template, sent last.
  const driverResult = await whatsappService.notifyDispatchDriver(
    { id: dispatch.id, vehicleNumber: dispatch.vehicleNumber, driverPhone: dispatch.driverPhone },
    { name: order.buyer.name, phone: order.buyer.phone, locationLink: order.buyer.locationLink }
  );

  return {
    ok: partyResult.ok || !!brokerResult?.ok,
    party: leg(partyResult),
    broker: brokerResult ? leg(brokerResult) : { status: 'na', error: null },
    // A null driverResult means no driver phone was captured, so nothing was
    // attempted; otherwise report what the send actually did, not just that we tried.
    driver: driverResult
      ? leg(driverResult)
      : { status: 'skipped', error: 'No driver phone on this dispatch' },
  };
}
