import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { renderInvoicePdf, type InvoicePdfData } from '../lib/invoicePdf.js';
import { renderEwbPdf } from '../lib/ewbPdf.js';
import { qrPngBuffer } from '../lib/qrcode.js';
import { getCompanyProfileRow } from '../controllers/settings.controller.js';
import { emailService } from './email.service.js';

/**
 * Loads everything needed to render the tax-invoice PDF for a dispatch
 * (buyer, company profile, product tax row) and shapes it into InvoicePdfData.
 * Shared by sendInvoiceEmail/sendEwbEmail below and the WhatsApp dispatch bundle.
 */
export async function buildInvoicePdfData(dispatchId: string) {
  const dispatch = await prisma.saleDispatch.findUnique({
    where: { id: dispatchId },
    include: { saleOrder: { include: { buyer: true } } },
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
  // A GST-exempt order (and every dispatch under it) is billed WITHOUT GST — the
  // invoice/EWB must show a 0% rate regardless of the product's default tax row.
  const gstFraction = order.gstExempt ? 0 : (taxRow?.gstRate != null ? Number(taxRow.gstRate) : 5) / 100;

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
      address: order.buyer.address,
      gstin: buyerGstin,
      stateName: order.buyer.state,
      stateCode: buyerStateCode,
      placeOfSupply: order.buyer.state,
    },
    invoiceNumber: dispatch.invoiceNumber,
    invoiceDate: dispatch.invoiceDate,
    destination: order.destination,
    vehicleNumber: dispatch.vehicleNumber,
    line: {
      description: taxRow?.description || order.product,
      hsn: taxRow?.hsn || '',
      quantityKg: dispatch.weightKg,
      ratePerKg: Number(order.ratePerKg),
    },
    gstRate: gstFraction,
    ewbNumber: dispatch.ewbNumber,
    irn,
  };

  return { dispatch, order, company, pdfData };
}

export async function sendInvoiceEmail(dispatchId: string) {
  const { dispatch, order, company, pdfData } = await buildInvoicePdfData(dispatchId);
  if (!dispatch.irn) throw new HttpError(400, 'Generate the E-Invoice (IRN) before emailing it');
  if (!order.buyer.email) throw new HttpError(400, `${order.buyer.name} has no email on file — add one in Parties first`);

  const buffer = await renderInvoicePdf(pdfData);
  const html = `<p>Dear ${order.buyer.name},</p>` +
    `<p>Please find attached the tax invoice <strong>${dispatch.invoiceNumber}</strong> along with the e-invoice (IRN) details.</p>` +
    `<p>Regards,<br/>${company.name}</p>`;

  return emailService.sendDocumentEmail({
    party: { id: order.buyer.id, email: order.buyer.email, name: order.buyer.name },
    documentType: 'INVOICE',
    referenceLabel: dispatch.invoiceNumber!,
    saleDispatchId: dispatch.id,
    subject: `Tax Invoice ${dispatch.invoiceNumber} - ${company.name}`,
    html,
    attachments: [{ filename: `${dispatch.invoiceNumber!.replace(/\//g, '-')}.pdf`, content: buffer }],
  });
}

export async function sendEwbEmail(dispatchId: string) {
  const { dispatch, order, company, pdfData } = await buildInvoicePdfData(dispatchId);
  if (!dispatch.ewbNumber) throw new HttpError(400, 'Generate the E-Way Bill before emailing it');
  if (!order.buyer.email) throw new HttpError(400, `${order.buyer.name} has no email on file — add one in Parties first`);

  const buffer = await renderEwbPdf({
    company: pdfData.company,
    buyer: pdfData.buyer,
    invoiceNumber: pdfData.invoiceNumber,
    invoiceDate: pdfData.invoiceDate,
    vehicleNumber: pdfData.vehicleNumber,
    line: pdfData.line,
    gstRate: pdfData.gstRate,
    ewbNumber: dispatch.ewbNumber,
    ewbDate: dispatch.ewbDate!,
    ewbValidUpto: dispatch.ewbValidUpto!,
    ewbDistance: dispatch.ewbDistance,
    dispatchDate: dispatch.dispatchDate,
    qrPngBuffer: await qrPngBuffer(dispatch.ewbNumber),
  });
  const html = `<p>Dear ${order.buyer.name},</p>` +
    `<p>Please find attached the e-way bill <strong>${dispatch.ewbNumber}</strong> for invoice ${dispatch.invoiceNumber}.</p>` +
    `<p>Valid up to: ${dispatch.ewbValidUpto ? dispatch.ewbValidUpto.toLocaleDateString('en-GB') : ''}</p>` +
    `<p>Regards,<br/>${company.name}</p>`;

  return emailService.sendDocumentEmail({
    party: { id: order.buyer.id, email: order.buyer.email, name: order.buyer.name },
    documentType: 'EWB',
    referenceLabel: dispatch.ewbNumber,
    saleDispatchId: dispatch.id,
    subject: `E-Way Bill ${dispatch.ewbNumber} - ${company.name}`,
    html,
    attachments: [{ filename: `EWB-${dispatch.ewbNumber}.pdf`, content: buffer }],
  });
}
