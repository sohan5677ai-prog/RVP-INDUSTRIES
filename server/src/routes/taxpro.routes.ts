import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { HttpError } from '../lib/httpError.js';
import { TaxproService } from '../services/taxpro.service.ts';
import { z } from 'zod';

const router = Router();

const cancelSchema = z.object({
  cancelReason: z.string().min(1),
  cancelRemarks: z.string().optional().default('Cancelled from ERP'),
});

const ewbSchema = z.object({
  transporterId: z.string().optional(),
  transporterName: z.string().optional(),
  transDistance: z.coerce.number().positive(),
  transMode: z.string().default('1'), // '1' - Road
  vehicleNumber: z.string().optional(),
  vehicleType: z.string().default('R'),
});

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

    const result = await TaxproService.generateIRN(id);

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

    const result = await TaxproService.cancelIRN(id, cancelReason, cancelRemarks);

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

    const result = await TaxproService.generateEWayBill(id, {
      transporterId: data.transporterId,
      transporterName: data.transporterName,
      transDistance: data.transDistance,
      transMode: data.transMode,
      vehicleNumber: data.vehicleNumber || dispatch.vehicleNumber || '',
      vehicleType: data.vehicleType,
    });

    const updated = await prisma.saleDispatch.update({
      where: { id },
      data: {
        ewbNumber: result.ewbNumber,
        ewbDate: result.ewbDate,
        ewbValidUpto: result.ewbValidUpto,
        ewbStatus: 'GENERATED',
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

    const result = await TaxproService.cancelEWayBill(id, cancelReason, cancelRemarks);

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

export default router;
