import type { Request, Response } from 'express';
import { computeBuyerDues, filterDuesPortfolio } from '../services/salesDues.service.js';
import { renderSalesDuesReportPdf } from '../lib/salesDuesPdf.js';
import { getCompanyProfileRow } from './settings.controller.js';

function strParam(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * GET /sale-dues/report.pdf - the buyer-grouped Outstanding Sales Dues PDF
 * (same renderer as the WhatsApp owner digest), scoped to whatever the Sale
 * Dues page's filters currently show. Query params mirror the page's own
 * filter state 1:1 - see `filterDuesPortfolio` for the exact matching rules.
 */
export async function downloadSaleDuesReportPdf(req: Request, res: Response) {
  const [profile, portfolio] = await Promise.all([getCompanyProfileRow(), computeBuyerDues()]);

  const filtered = filterDuesPortfolio(portfolio, {
    product: strParam(req.query.product),
    month: strParam(req.query.month),
    search: strParam(req.query.search),
    billFrom: strParam(req.query.from),
    billTo: strParam(req.query.to),
  });

  const buffer = await renderSalesDuesReportPdf(
    {
      name: profile.name,
      address: profile.address,
      gstin: profile.gstin,
      contact: profile.contact,
      stateName: profile.stateName,
      stateCode: profile.stateCode,
      pincode: profile.pincode,
    },
    filtered,
  );

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Outstanding-Sales-Dues-${stamp}.pdf"`);
  res.send(buffer);
}
