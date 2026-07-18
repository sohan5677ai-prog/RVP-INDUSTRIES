import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { HttpError } from '../lib/httpError.js';
import { TaxproService } from '../services/taxpro.service.js';
import { sendInvoiceEmail, sendEwbEmail } from '../services/saleDocumentEmail.service.js';
import { z } from 'zod';

const router = Router();

/**
 * Runs a TaxPro service call and, on failure, re-throws as an HttpError so the
 * real GSP/NIC message reaches the client instead of a generic 500. Business
 * validation faults (bad payload, NIC rejection) are surfaced verbatim; a
 * pre-existing HttpError (e.g. 400 from earlier checks) is passed through.
 */
async function runTaxpro<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    // 502: the failure originated at the upstream GSP/NIC gateway (or in
    // building the payload we send it), not from our own request handling.
    throw new HttpError(502, message);
  }
}

const cancelSchema = z.object({
  cancelReason: z.string().min(1),
  cancelRemarks: z.string().optional().default('Cancelled from ERP'),
});

const ewbSchema = z.object({
  transporterId: z.string().optional(),
  transporterName: z.string().optional(),
  transDistance: z.coerce.number().nonnegative().default(0),
  transMode: z.string().default('1'), // '1' - Road
  vehicleNumber: z.string().optional(),
  vehicleType: z.string().default('R'),
  transDocNo: z.string().optional(),  // LR/RR/Airway bill no (rail/air/ship)
  transDocDt: z.string().optional(),  // yyyy-mm-dd from the date input
});

// Get list of generated IRNs and EWBs
router.get(
  '/taxpro/list',
  asyncHandler(async (req, res) => {
    // Currently, only SaleDispatches have IRNs/EWBs
    const sales = await prisma.saleDispatch.findMany({
      where: {
        OR: [
          { irn: { not: null } },
          { ewbNumber: { not: null } },
        ],
      },
      include: {
        saleOrder: {
          include: {
            buyer: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ sales, purchases: [] });
  })
);

// Generate E-Invoice (IRN)
router.post(
  '/sale-dispatches/:id/einvoice',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const dispatch = await prisma.saleDispatch.findUnique({
      where: { id },
    });
    if (!dispatch) throw new HttpError(404, 'Dispatch not found');
    if (!dispatch.invoiceNumber) throw new HttpError(400, 'Tax Invoice must be raised before E-Invoice');
    if (dispatch.irn) throw new HttpError(400, 'E-Invoice IRN already generated for this dispatch');

    const result = await runTaxpro(() => TaxproService.generateIRN(id));

    const updated = await prisma.saleDispatch.update({
      where: { id },
      data: {
        irn: result.irn,
        irnAckNo: result.ackNo,
        irnAckDate: result.ackDate,
        irnSignedQr: result.signedQr,
        irnStatus: 'GENERATED',
      },
      include: { saleOrder: { include: { buyer: true } } },
    });

    res.json({ updated, message: result.message });
  })
);

// Cancel E-Invoice (IRN)
router.post(
  '/sale-dispatches/:id/einvoice/cancel',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { cancelReason, cancelRemarks } = cancelSchema.parse(req.body);

    const dispatch = await prisma.saleDispatch.findUnique({
      where: { id },
    });
    if (!dispatch) throw new HttpError(404, 'Dispatch not found');
    if (!dispatch.irn) throw new HttpError(400, 'No E-Invoice found to cancel');
    if (dispatch.irnStatus === 'CANCELLED') throw new HttpError(400, 'E-Invoice is already cancelled');

    const result = await runTaxpro(() => TaxproService.cancelIRN(id, cancelReason, cancelRemarks));

    const updated = await prisma.saleDispatch.update({
      where: { id },
      data: {
        irnStatus: 'CANCELLED',
        irnCancelledDate: result.cancelledDate,
      },
      include: { saleOrder: { include: { buyer: true } } },
    });

    res.json({ updated, message: result.message });
  })
);

// Generate E-Way Bill
router.post(
  '/sale-dispatches/:id/ewaybill',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const data = ewbSchema.parse(req.body);

    const dispatch = await prisma.saleDispatch.findUnique({
      where: { id },
    });
    if (!dispatch) throw new HttpError(404, 'Dispatch not found');
    if (!dispatch.irn) throw new HttpError(400, 'E-Invoice IRN must be generated before E-Way Bill');
    if (dispatch.ewbNumber) throw new HttpError(400, 'E-Way Bill already generated for this dispatch');

    const result = await runTaxpro(() => TaxproService.generateEWayBill(id, {
      transporterId: data.transporterId,
      transporterName: data.transporterName,
      transDistance: data.transDistance,
      transMode: data.transMode,
      vehicleNumber: data.vehicleNumber || dispatch.vehicleNumber || '',
      vehicleType: data.vehicleType,
      transDocNo: data.transDocNo,
      transDocDt: data.transDocDt,
    }));

    const updated = await prisma.saleDispatch.update({
      where: { id },
      data: {
        ewbNumber: result.ewbNumber,
        ewbDate: result.ewbDate,
        ewbValidUpto: result.ewbValidUpto,
        ewbStatus: 'GENERATED',
        ewbDistance: data.transDistance > 0 ? Math.round(data.transDistance) : null,
      },
      include: { saleOrder: { include: { buyer: true } } },
    });

    res.json({ updated, message: result.message });
  })
);

// Cancel E-Way Bill
router.post(
  '/sale-dispatches/:id/ewaybill/cancel',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { cancelReason, cancelRemarks } = cancelSchema.parse(req.body);

    const dispatch = await prisma.saleDispatch.findUnique({
      where: { id },
    });
    if (!dispatch) throw new HttpError(404, 'Dispatch not found');
    if (!dispatch.ewbNumber) throw new HttpError(400, 'No E-Way Bill found to cancel');
    if (dispatch.ewbStatus === 'CANCELLED') throw new HttpError(400, 'E-Way Bill is already cancelled');

    const result = await runTaxpro(() => TaxproService.cancelEWayBill(id, cancelReason, cancelRemarks));

    const updated = await prisma.saleDispatch.update({
      where: { id },
      data: {
        ewbStatus: 'CANCELLED',
        ewbCancelledDate: result.cancelledDate,
      },
      include: { saleOrder: { include: { buyer: true } } },
    });

    res.json({ updated, message: result.message });
  })
);

// Email the tax invoice (with IRN/QR if generated) to the buyer.
router.post(
  '/sale-dispatches/:id/einvoice/email',
  asyncHandler(async (req, res) => {
    const result = await sendInvoiceEmail(req.params.id);
    if (!result.ok) throw new HttpError(502, result.error || 'Failed to send email');
    res.json(result);
  })
);

// Email the e-way bill details to the buyer.
router.post(
  '/sale-dispatches/:id/ewaybill/email',
  asyncHandler(async (req, res) => {
    const result = await sendEwbEmail(req.params.id);
    if (!result.ok) throw new HttpError(502, result.error || 'Failed to send email');
    res.json(result);
  })
);

export default router;
