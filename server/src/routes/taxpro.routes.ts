import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { HttpError } from '../lib/httpError.js';
import { TaxproService } from '../services/taxpro.service.js';
import { sendInvoiceEmail, sendEwbEmail } from '../services/saleDocumentEmail.service.js';
import { sendDispatchBundleWhatsApp } from '../services/dispatchWhatsapp.service.js';
import { resolveEwbDistance } from '../services/ewbDistance.service.js';
import { logger } from '../lib/logger.js';
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
  forceCascade: z.boolean().optional().default(false),
});

const updateVehicleSchema = z.object({
  vehicleNumber: z.string().min(1, 'Vehicle number is required'),
  fromPlace: z.string().min(1, 'From place is required'),
  fromState: z.coerce.number().int(),
  reasonCode: z.string().default('1'),
  reasonRem: z.string().default('Vehicle updated from ERP'),
  transDocNo: z.string().optional(),
  transDocDt: z.string().optional(),
  transMode: z.string().default('1'),
  vehicleType: z.string().default('R'),
});

const extendValiditySchema = z.object({
  vehicleNumber: z.string().min(1, 'Vehicle number is required'),
  fromPlace: z.string().min(1, 'From place is required'),
  fromState: z.coerce.number().int(),
  fromPincode: z.coerce.number().int(),
  remainingDistance: z.coerce.number().int().min(1, 'Remaining distance must be > 0'),
  extnRsnCode: z.coerce.number().int().default(1),
  extnRemarks: z.string().default('Extended from ERP'),
  consignmentStatus: z.string().default('T'),
  transitType: z.string().default('R'),
  transDocNo: z.string().optional(),
  transDocDt: z.string().optional(),
  transMode: z.string().default('1'),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  addressLine3: z.string().optional(),
});

const ewbSchema = z.object({
  transporterId: z.string().optional(),
  transporterName: z.string().optional(),
  // Optional override. Left out (or 0), the server works the distance out
  // itself - see resolveEwbDistance. It can never be filed as 0: NIC accepts a
  // 0 and computes its own figure, but never tells us what it computed, and the
  // official print is rendered from OUR record, so the printed bill would read
  // "0 KM" and be invalid.
  transDistance: z.coerce.number().int().min(0).max(4000).optional(),
  transMode: z.string().default('1'), // '1' - Road
  vehicleNumber: z.string().optional(),
  vehicleType: z.string().default('R'),
  transDocNo: z.string().optional(),  // LR/RR/Airway bill no (rail/air/ship)
  transDocDt: z.string().optional(),  // yyyy-mm-dd from the date input
  // Set by the "Generate IRN and E-Way Bill" flow only: once the EWB exists the
  // invoice+EWB bundle goes straight out on WhatsApp. The standalone "Gen EWB"
  // dialog leaves this false and stays silent.
  notifyWhatsApp: z.boolean().optional().default(false),
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
    if (dispatch.irn && dispatch.irnStatus !== 'CANCELLED') throw new HttpError(400, 'Active E-Invoice IRN already generated for this dispatch');

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
    const { cancelReason, cancelRemarks, forceCascade } = cancelSchema.parse(req.body);

    const dispatch = await prisma.saleDispatch.findUnique({
      where: { id },
    });
    if (!dispatch) throw new HttpError(404, 'Dispatch not found');
    if (!dispatch.irn) throw new HttpError(400, 'No E-Invoice found to cancel');
    if (dispatch.irnStatus === 'CANCELLED') throw new HttpError(400, 'E-Invoice is already cancelled');

    // Under GST rules, IRN CANNOT be cancelled while an active E-Way Bill exists.
    if (dispatch.ewbNumber && dispatch.ewbStatus !== 'CANCELLED') {
      if (!forceCascade) {
        throw new HttpError(
          400,
          `An active E-Way Bill (${dispatch.ewbNumber}) is linked to this invoice. Under GST rules, you must cancel the E-Way Bill first before cancelling the E-Invoice.`,
        );
      }
      // If forceCascade is requested, cancel the EWB first
      logger.info(`[taxpro] Auto-cancelling active EWB ${dispatch.ewbNumber} before cancelling IRN for dispatch ${id}`);
      const ewbCancel = await runTaxpro(() =>
        TaxproService.cancelEWayBill(id, '2', 'Order cancelled with invoice'),
      );
      await prisma.saleDispatch.update({
        where: { id },
        data: {
          ewbStatus: 'CANCELLED',
          ewbCancelledDate: ewbCancel.cancelledDate,
        },
      });
    }

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
    // Lockout fix: Only block if an ACTIVE (not cancelled) E-Way Bill already exists!
    if (dispatch.ewbNumber && dispatch.ewbStatus !== 'CANCELLED') {
      throw new HttpError(400, `Active E-Way Bill (${dispatch.ewbNumber}) already generated for this dispatch`);
    }

    // Worked out here for local record / preview / WhatsApp / PDF print:
    // reused from this buyer's last bill, or routed from dispatch-from PIN code to buyer's.
    const distance = await resolveEwbDistance(id, data.transDistance);

    // If the operator entered a specific distance manually (data.transDistance > 0),
    // send that; otherwise pass 0 so NIC auto-calculates from its official PIN database.
    const transDistanceToSend = (data.transDistance && data.transDistance > 0) ? data.transDistance : 0;

    const result = await runTaxpro(async () => {
      return await TaxproService.generateEWayBill(id, {
        transporterId: data.transporterId,
        transporterName: data.transporterName,
        transDistance: transDistanceToSend,
        transMode: data.transMode,
        vehicleNumber: data.vehicleNumber || dispatch.vehicleNumber || '',
        vehicleType: data.vehicleType,
        transDocNo: data.transDocNo,
        transDocDt: data.transDocDt,
      });
    });

    const updated = await prisma.saleDispatch.update({
      where: { id },
      data: {
        ewbNumber: result.ewbNumber,
        ewbDate: result.ewbDate,
        ewbValidUpto: result.ewbValidUpto,
        ewbStatus: 'GENERATED',
        // The distance the bill was raised with - this is the figure the official
        // print renders as "Approx Distance", so it must never be left empty.
        ewbDistance: result.distance && result.distance > 0
          ? Math.round(result.distance)
          : (distance?.km ?? null),
        ewbTransMode: data.transMode,
        ewbVehicleType: data.vehicleType,
        ewbTransDocNo: data.transDocNo || null,
        ewbTransDocDate: data.transDocDt ? new Date(data.transDocDt) : null,
      },
      include: { saleOrder: { include: { buyer: true } } },
    });

    // The EWB is generated and saved at this point - a WhatsApp failure must not
    // fail the request or make the caller think the EWB didn't happen. Report the
    // per-leg outcome alongside it and let the UI surface any leg that didn't land.
    let whatsapp = null;
    if (data.notifyWhatsApp) {
      try {
        whatsapp = await sendDispatchBundleWhatsApp(id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[taxpro] EWB ${result.ewbNumber} generated but WhatsApp bundle failed: ${message}`);
        whatsapp = {
          ok: false,
          party: { status: 'failed' as const, error: message },
          broker: { status: 'na' as const, error: null },
          driver: { status: 'failed' as const, error: message },
          internal: { status: 'failed' as const, error: message },
        };
      }
    }

    res.json({ updated, message: result.message, whatsapp });
  })
);

// The approx distance this dispatch's E-Way Bill will be raised with, worked
// out the same way the generation route works it out. Purely so the dialog can
// show the operator what is about to be filed (and warn early on the rare route
// that can't be resolved) - nothing here has to be answered.
router.get(
  '/sale-dispatches/:id/ewaybill/distance-hint',
  asyncHandler(async (req, res) => {
    const dispatch = await prisma.saleDispatch.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!dispatch) throw new HttpError(404, 'Dispatch not found');

    const resolved = await resolveEwbDistance(req.params.id);
    res.json({
      distance: resolved?.km ?? null,
      source: resolved?.source ?? null,
      detail: resolved?.detail ?? null,
    });
  })
);

// Record (or correct) the approx distance on an E-Way Bill that already exists.
// This is what unblocks a bill raised before the distance was captured: NIC
// holds the real figure, the operator reads it off the portal, and saving it
// here makes every reprint / WhatsApp copy show it instead of 0 KM.
router.patch(
  '/sale-dispatches/:id/ewaybill/distance',
  asyncHandler(async (req, res) => {
    const { distance } = z
      .object({ distance: z.coerce.number().int().min(1).max(4000) })
      .parse(req.body);

    const dispatch = await prisma.saleDispatch.findUnique({ where: { id: req.params.id } });
    if (!dispatch) throw new HttpError(404, 'Dispatch not found');
    if (!dispatch.ewbNumber) throw new HttpError(400, 'No E-Way Bill found on this dispatch');

    const updated = await prisma.saleDispatch.update({
      where: { id: req.params.id },
      data: { ewbDistance: distance },
      include: { saleOrder: { include: { buyer: true } } },
    });

    res.json({ updated, message: `Approx distance saved as ${distance} KM` });
  })
);

// Fetch the official ASP-rendered E-Way Bill PDF (the real government print,
// not our HTML replica). ?detail=1 returns the EWB portal's "detailed" layout.
router.get(
  '/sale-dispatches/:id/ewaybill/print-pdf',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const detailed = req.query.detail === '1' || req.query.detail === 'true';

    const dispatch = await prisma.saleDispatch.findUnique({ where: { id } });
    if (!dispatch) throw new HttpError(404, 'Dispatch not found');
    if (!dispatch.ewbNumber) throw new HttpError(400, 'No E-Way Bill found to print');

    const pdf = await runTaxpro(() =>
      detailed ? TaxproService.printEWayBillDetailPdf(id) : TaxproService.printEWayBillPdf(id)
    );
    const suffix = detailed ? '-detailed' : '';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="EWB-${dispatch.ewbNumber}${suffix}.pdf"`);
    res.send(pdf);
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

// Update Vehicle (Part-B) of active E-Way Bill
router.post(
  '/sale-dispatches/:id/ewaybill/update-vehicle',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const body = updateVehicleSchema.parse(req.body);

    const dispatch = await prisma.saleDispatch.findUnique({ where: { id } });
    if (!dispatch) throw new HttpError(404, 'Dispatch not found');
    if (!dispatch.ewbNumber) throw new HttpError(400, 'No E-Way Bill found to update');
    if (dispatch.ewbStatus === 'CANCELLED') throw new HttpError(400, 'E-Way Bill is cancelled');

    const result = await runTaxpro(() =>
      TaxproService.updateVehicle(id, {
        vehicleNo: body.vehicleNumber,
        fromPlace: body.fromPlace,
        fromState: body.fromState,
        reasonCode: body.reasonCode,
        reasonRem: body.reasonRem,
        transDocNo: body.transDocNo,
        transDocDate: body.transDocDt,
        transMode: body.transMode,
        vehicleType: body.vehicleType,
      })
    );

    const updated = await prisma.saleDispatch.update({
      where: { id },
      data: {
        vehicleNumber: result.vehicleNo,
        ...(result.validUpto ? { ewbValidUpto: result.validUpto } : {}),
      },
      include: { saleOrder: { include: { buyer: true } } },
    });

    res.json({ updated, message: result.message });
  })
);

// Extend E-Way Bill validity
router.post(
  '/sale-dispatches/:id/ewaybill/extend-validity',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const body = extendValiditySchema.parse(req.body);

    const dispatch = await prisma.saleDispatch.findUnique({ where: { id } });
    if (!dispatch) throw new HttpError(404, 'Dispatch not found');
    if (!dispatch.ewbNumber) throw new HttpError(400, 'No E-Way Bill found to extend');
    if (dispatch.ewbStatus === 'CANCELLED') throw new HttpError(400, 'E-Way Bill is cancelled');

    const result = await runTaxpro(() =>
      TaxproService.extendValidity(id, {
        vehicleNo: body.vehicleNumber,
        fromPlace: body.fromPlace,
        fromState: body.fromState,
        fromPincode: body.fromPincode,
        remainingDistance: body.remainingDistance,
        extnRsnCode: body.extnRsnCode,
        extnRemarks: body.extnRemarks,
        consignmentStatus: body.consignmentStatus,
        transitType: body.transitType,
        transDocNo: body.transDocNo,
        transDocDate: body.transDocDt,
        transMode: body.transMode,
        addressLine1: body.addressLine1,
        addressLine2: body.addressLine2,
        addressLine3: body.addressLine3,
      })
    );

    const updated = await prisma.saleDispatch.update({
      where: { id },
      data: {
        ewbValidUpto: result.newValidUpto,
        ewbDistance: body.remainingDistance,
      },
      include: { saleOrder: { include: { buyer: true } } },
    });

    res.json({ updated, message: result.message });
  })
);

// Live E-Way Bill Status & Details from NIC
router.get(
  '/sale-dispatches/:id/ewaybill/live-status',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const dispatch = await prisma.saleDispatch.findUnique({ where: { id } });
    if (!dispatch) throw new HttpError(404, 'Dispatch not found');
    if (!dispatch.ewbNumber) throw new HttpError(400, 'No E-Way Bill found');

    const result = await runTaxpro(() => TaxproService.getLiveEwayBill(dispatch.ewbNumber!));
    const liveData = result.data || {};
    const liveStatus = String(liveData.status || liveData.Status || '').toUpperCase();

    let updated = dispatch;
    if (liveStatus === 'CNL' || liveStatus === 'CANCELLED') {
      updated = await prisma.saleDispatch.update({
        where: { id },
        data: {
          ewbStatus: 'CANCELLED',
          ewbCancelledDate: liveData.cancelDate ? TaxproService.parseNicDate(liveData.cancelDate) : new Date(),
        },
        include: { saleOrder: { include: { buyer: true } } },
      });
    }

    res.json({ liveData, updated, message: 'Live E-Way Bill status fetched' });
  })
);

// Live E-Invoice IRN Status & Details from NIC
router.get(
  '/sale-dispatches/:id/einvoice/live-status',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const dispatch = await prisma.saleDispatch.findUnique({ where: { id } });
    if (!dispatch) throw new HttpError(404, 'Dispatch not found');
    if (!dispatch.irn) throw new HttpError(400, 'No E-Invoice IRN found');

    const result = await runTaxpro(() => TaxproService.getLiveIRN(dispatch.irn!));
    const liveData = result.data || {};
    const liveStatus = String(liveData.status || liveData.Status || '').toUpperCase();

    let updated = dispatch;
    if (liveStatus === 'CNL' || liveStatus === 'CANCELLED') {
      updated = await prisma.saleDispatch.update({
        where: { id },
        data: {
          irnStatus: 'CANCELLED',
          irnCancelledDate: liveData.CancelDate ? TaxproService.parseNicDate(liveData.CancelDate) : new Date(),
        },
        include: { saleOrder: { include: { buyer: true } } },
      });
    }

    res.json({ liveData, updated, message: 'Live E-Invoice status fetched' });
  })
);

// Transporter master lookup by GSTIN/TRANSIN
router.get(
  '/taxpro/transporter/:trnNo',
  asyncHandler(async (req, res) => {
    const { trnNo } = req.params;
    const result = await runTaxpro(() => TaxproService.getTransporterDetails(trnNo));
    res.json(result);
  })
);

// Fetch Inward E-Way Bills (purchases from suppliers) by date
router.get(
  '/taxpro/inward-ewb',
  asyncHandler(async (req, res) => {
    const date = req.query.date as string | undefined;
    const result = await runTaxpro(() => TaxproService.getInwardEwayBills(date));
    res.json(result);
  })
);

// Reject Inward E-Way Bill
router.post(
  '/taxpro/reject-ewb',
  asyncHandler(async (req, res) => {
    const { ewbNo } = z.object({ ewbNo: z.string().min(1) }).parse(req.body);
    const result = await runTaxpro(() => TaxproService.rejectEwayBill(ewbNo));
    res.json(result);
  })
);

export default router;

