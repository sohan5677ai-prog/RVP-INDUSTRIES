import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { renderInvoicePdf, type InvoicePdfData } from '../lib/invoicePdf.js';
import { renderEwbPdf } from '../lib/ewbPdf.js';
import { renderLorryReceiptPdf } from '../lib/lorryReceiptPdf.js';
import { qrPngBuffer } from '../lib/qrcode.js';
import { mergePdfs } from '../lib/pdfMerge.js';
import { getCompanyProfileRow } from '../controllers/settings.controller.js';
import { emailService } from './email.service.js';
import { resolveProductHsn } from '../lib/calc.js';
import { invoiceEmailHtml } from '../lib/emailTemplates.js';
import { TaxproService } from './taxpro.service.js';
import { ensureLorryReceiptAssigned } from '../controllers/sale.controller.js';
import { clearCache } from '../lib/cache.js';
import { resolveOrderEffectiveDetails } from '../lib/orderAddress.js';
import { logger } from '../lib/logger.js';

/**
 * Loads everything needed to render the tax-invoice PDF for a dispatch
 * (buyer, company profile, product tax row) and shapes it into InvoicePdfData.
 * Shared by sendDispatchBundleEmail and the WhatsApp dispatch bundle.
 */
export async function buildInvoicePdfData(dispatchId: string) {
  const dispatch = await prisma.saleDispatch.findUnique({
    where: { id: dispatchId },
    include: { saleOrder: { include: { buyer: true, broker: true } } },
  });
  if (!dispatch) throw new HttpError(404, 'Dispatch not found');
  if (!dispatch.invoiceNumber || !dispatch.invoiceDate) {
    throw new HttpError(400, 'Tax Invoice must be raised for this dispatch first');
  }

  const order = dispatch.saleOrder;
  const [company, taxRow] = await Promise.all([
    getCompanyProfileRow(),
    prisma.productTaxInfo.findUnique({ where: { product: order.product } }),
  ]);

  const buyerGstin = order.buyer.gstin ?? null;
  const buyerStateCode = buyerGstin && /^\d{2}/.test(buyerGstin) ? buyerGstin.slice(0, 2) : null;
  // A GST-exempt order (and every dispatch under it) is billed WITHOUT GST - the
  // invoice/EWB must show a 0% rate regardless of the product's default tax row.
  const gstFraction = order.gstExempt ? 0 : (taxRow?.gstRate != null ? Number(taxRow.gstRate) : 5) / 100;
  // Krishi Nutrition Company Pvt Ltd uses constant HSN 11063010; other buyers use
  // the product's configured HSN (or exempt variant if gstExempt).
  const hsn = resolveProductHsn(order.buyer, taxRow, order.gstExempt);

  const irn = dispatch.irn
    ? {
        irn: dispatch.irn,
        ackNo: dispatch.irnAckNo ?? '',
        ackDate: dispatch.irnAckDate ?? new Date(),
        qrPngBuffer: dispatch.irnSignedQr ? await qrPngBuffer(dispatch.irnSignedQr) : undefined,
      }
    : null;

  const pdfData: InvoicePdfData = {
    company: {
      name: company.name,
      address: company.address,
      gstin: company.gstin,
      stateName: company.stateName,
      stateCode: company.stateCode,
      contact: company.contact,
      bankAccountName: company.bankAccountName,
      bankName: company.bankName,
      bankAccountNumber: company.bankAccountNumber,
      bankBranchIfsc: company.bankBranchIfsc,
    },
    buyer: {
      name: order.buyer.name,
      address: order.buyerAddress || order.buyer.address,
      gstin: order.buyerGstin || buyerGstin,
      stateName: order.buyerState || order.buyer.state,
      stateCode: order.buyerGstin && /^\d{2}/.test(order.buyerGstin) ? order.buyerGstin.slice(0, 2) : buyerStateCode,
      placeOfSupply: order.buyerState || order.buyer.state,
    },
    invoiceNumber: dispatch.invoiceNumber,
    invoiceDate: dispatch.invoiceDate,
    poNumber: order.poNumber,
    poDate: order.poDate,
    otherReferences: order.broker?.name ?? null,
    destination: order.destination,
    vehicleNumber: dispatch.vehicleNumber,
    line: {
      description: taxRow?.description || order.product,
      hsn,
      quantityKg: dispatch.weightKg,
      ratePerKg: Number(order.ratePerKg),
    },
    gstRate: gstFraction,
    ewbNumber: dispatch.ewbNumber,
    irn,
  };

  return { dispatch, order, company, pdfData };
}

async function renderDispatchEwbPdf(
  dispatch: Awaited<ReturnType<typeof buildInvoicePdfData>>['dispatch'],
  order: Awaited<ReturnType<typeof buildInvoicePdfData>>['order'],
  company: Awaited<ReturnType<typeof buildInvoicePdfData>>['company'],
  pdfData: Awaited<ReturnType<typeof buildInvoicePdfData>>['pdfData'],
  selectedAddress?: { pincode?: string | null; city?: string | null } | null,
): Promise<Buffer> {
  try {
    return await TaxproService.printEWayBillDetailPdf(dispatch.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[dispatch-email] official EWB print failed for ${dispatch.ewbNumber} - attaching in-house replica: ${message}`);
    return renderEwbPdf({
      company: { ...pdfData.company, pincode: company.pincode },
      buyer: { ...pdfData.buyer, pincode: order.buyerPincode || selectedAddress?.pincode || order.buyer.pincode },
      dispatchFrom: {
        place: company.dispatchFromPlace,
        address1: company.dispatchFromAddress1,
        address2: company.dispatchFromAddress2,
        pincode: company.dispatchFromPincode,
      },
      shipToPlace: order.buyerCity || selectedAddress?.city || order.buyer.city,
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
 * Send the combined dispatch bundle email (Tax Invoice + E-Way Bill + Lorry Receipt if enabled).
 * Automatically sets:
 * - TO: Buyer party email
 * - CC: Broker email (if associated with order and has email)
 * - BCC: Company BCC email (from Settings)
 */
export async function sendDispatchBundleEmail(dispatchId: string) {
  const { dispatch, order, company, pdfData } = await buildInvoicePdfData(dispatchId);
  if (!order.buyer.email) throw new HttpError(400, `${order.buyer.name} has no email on file - add one in Parties first`);

  const { selectedAddress } = await resolveOrderEffectiveDetails(order);

  const invoiceBuffer = await renderInvoicePdf(pdfData);
  const pages: Buffer[] = [invoiceBuffer];
  const attachedDocs: string[] = ['Tax Invoice'];

  const hasEwb = !!(dispatch.ewbNumber && dispatch.ewbDate && dispatch.ewbValidUpto);
  if (hasEwb) {
    const ewbBuffer = await renderDispatchEwbPdf(dispatch, order, company, pdfData, selectedAddress);
    pages.push(ewbBuffer);
    attachedDocs.push('E-Way Bill');
  }

  let lrNumber: string | null = null;
  if (order.buyer.lorryReceiptEnabled) {
    const lrDispatch = await ensureLorryReceiptAssigned(dispatch.id);
    clearCache('sale-orders');
    if (lrDispatch?.lrNumber) {
      lrNumber = lrDispatch.lrNumber;
      const lrBuffer = await renderLorryReceiptPdf({
        company: {
          name: company.name,
          address: company.address,
          dispatchFromPlace: company.dispatchFromPlace,
          stateName: company.stateName,
        },
        buyer: {
          name: order.buyer.name,
          address: order.buyerAddress || selectedAddress?.address || order.buyer.address,
          city: order.buyerCity || selectedAddress?.city || order.buyer.city,
          state: order.buyerState || selectedAddress?.state || order.buyer.state,
          pincode: order.buyerPincode || selectedAddress?.pincode || order.buyer.pincode,
        },
        destination: order.destination || selectedAddress?.destination || order.buyer.destination,
        product: order.product,
        invoiceNumber: dispatch.invoiceNumber,
        vehicleNumber: dispatch.vehicleNumber,
        driverName: dispatch.driverName,
        weightKg: dispatch.weightKg,
        gcNo: lrDispatch.lrNumber,
        gcDate: lrDispatch.lrDate ?? dispatch.invoiceDate ?? dispatch.dispatchDate,
        bags: lrDispatch.lrBags,
        kgPerBag: lrDispatch.lrKgPerBag,
        transportProvider: lrDispatch?.transportProvider || dispatch.transportProvider,
      });
      pages.push(lrBuffer);
      attachedDocs.push('Lorry Receipt');
    }
  }

  const finalPdfBuffer = pages.length > 1 ? await mergePdfs(pages) : invoiceBuffer;

  const lineTotal = pdfData.line.quantityKg * pdfData.line.ratePerKg;
  const invoiceAmount = lineTotal + lineTotal * pdfData.gstRate;

  const html = invoiceEmailHtml({
    partyName: order.buyer.name,
    invoiceNumber: dispatch.invoiceNumber!,
    invoiceDate: dispatch.invoiceDate!,
    amount: invoiceAmount,
    irn: dispatch.irn ?? undefined,
    vehicleNumber: dispatch.vehicleNumber,
    companyName: company.name,
    companyAddress: company.address,
    companyGstin: company.gstin,
    companyContact: company.contact,
    ewbNumber: hasEwb ? dispatch.ewbNumber : null,
    ewbValidUpto: hasEwb ? dispatch.ewbValidUpto : null,
    lrNumber,
    attachedDocs,
  });

  const brokerEmail = order.broker?.email?.trim() || undefined;
  const companyBcc = (company as any).companyBccEmail?.trim() || undefined;

  const docSummary = attachedDocs.join(' & ');
  const filename = `${dispatch.invoiceNumber!.replace(/\//g, '-')}-bundle.pdf`;

  return emailService.sendDocumentEmail({
    party: { id: order.buyer.id, email: order.buyer.email, name: order.buyer.name },
    documentType: 'INVOICE',
    referenceLabel: dispatch.invoiceNumber!,
    saleDispatchId: dispatch.id,
    subject: `${docSummary} ${dispatch.invoiceNumber} - ${company.name}`,
    html,
    attachments: [{ filename, content: finalPdfBuffer }],
    cc: brokerEmail ? [brokerEmail] : undefined,
    bcc: companyBcc ? [companyBcc] : undefined,
  });
}

/** Backwards-compatible aliases for existing routes and logs */
export const sendInvoiceEmail = sendDispatchBundleEmail;
export const sendEwbEmail = sendDispatchBundleEmail;

