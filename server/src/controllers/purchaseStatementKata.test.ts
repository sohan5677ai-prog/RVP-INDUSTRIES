import { describe, it, expect } from 'vitest';
import { PDFDocument as PDFLibDoc } from 'pdf-lib';
import { renderPurchaseStatementPdf, type PurchaseStatementData } from '../lib/purchaseStatementPdf.js';
import { generateWeighbridgeSlipJpeg } from '../lib/weighbridgeSlipImage.js';

describe('Purchase Statement Kata Slip Integration', () => {
  const baseData: PurchaseStatementData = {
    company: {
      name: 'RVP INDUSTRIES',
      address: 'Industrial Area, Rayachoty',
      gstin: '37AAAAA0000A1Z5',
      contact: '9848012345',
    },
    party: {
      name: 'SRI BALAJI ENTERPRISES',
      address: 'Madanapalle, AP',
      gstin: '37BBBBB1111B1Z2',
      phone: '9876543210',
    },
    invoiceNumber: 'INV-2026-089',
    statementDate: new Date('2026-09-20T10:00:00Z'),
    lorryNumber: 'AP39UX9105',
    poNumber: 'PO-2026-042',
    selfVehicle: false,
    weights: {
      billingKg: 28000,
      partyKataKg: 28050,
      rvpKataKg: 28000,
      referenceKg: 28000,
      diffKg: 0,
      exempt: true,
      payableKg: 28000,
    },
    allowanceKg: 80,
    pricePerKg: 35.5,
    qualityAdjustments: [],
    billAddables: [],
    gstRate: 0.05,
    gstAmount: 49700,
    gstBasisKg: 28000,
    selfVehicleHamali: 0,
    selfVehicleKata: 0,
    netPayable: 1043700,
    lang: 'en',
  };

  it('renders a 1-page PDF when no Kata slip is present', async () => {
    const pdfBuffer = await renderPurchaseStatementPdf(baseData);
    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(1000);

    const pdfDoc = await PDFLibDoc.load(pdfBuffer);
    expect(pdfDoc.getPageCount()).toBe(1);
  });

  it('renders a 2-page PDF when Kata slip JPEG and ticket are attached', async () => {
    // Generate an official Kata slip JPEG
    const kataSlipJpeg = await generateWeighbridgeSlipJpeg({
      ticketNo: 89,
      vehicleNumber: 'AP39UX9105',
      partyName: 'SRI BALAJI ENTERPRISES',
      material: 'TAMARIND SEED',
      firstWeightKg: 38200,
      secondWeightKg: 10200,
      netWeightKg: 28000,
      firstWeighedAt: new Date('2026-09-20T08:30:00Z'),
      secondWeighedAt: new Date('2026-09-20T10:15:00Z'),
    });

    expect(kataSlipJpeg).toBeInstanceOf(Buffer);
    expect(kataSlipJpeg.length).toBeGreaterThan(5000);

    const statementWithKata: PurchaseStatementData = {
      ...baseData,
      kataSlipImage: kataSlipJpeg,
      kataTicket: {
        id: 'ticket-89',
        ticketNo: 89,
        vehicleNumber: 'AP39UX9105',
        partyName: 'SRI BALAJI ENTERPRISES',
        material: 'TAMARIND SEED',
        firstWeightKg: 38200,
        secondWeightKg: 10200,
        netWeightKg: 28000,
        firstWeighedAt: new Date('2026-09-20T08:30:00Z'),
        secondWeighedAt: new Date('2026-09-20T10:15:00Z'),
        status: 'COMPLETED',
      },
    };

    const pdfBuffer = await renderPurchaseStatementPdf(statementWithKata);
    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(10000);

    const pdfDoc = await PDFLibDoc.load(pdfBuffer);
    // Verified 2-page output: Page 1 = settlement breakdown, Page 2 = Kata certificate
    expect(pdfDoc.getPageCount()).toBe(2);
  });
});
