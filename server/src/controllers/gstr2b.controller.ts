import { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { Gstr2bReconciliationService } from '../services/gstr2bReconciliation.service.js';

export async function syncGstr2b(req: Request, res: Response) {
  const period = String(req.body.period || '').replace(/[^0-9]/g, '');
  if (period.length !== 6) {
    return res.status(400).json({ error: 'Valid 6-digit return period required (e.g. 082026 for Aug 2026)' });
  }

  try {
    const result = await Gstr2bReconciliationService.syncFromTaxPro(period);
    return res.json(result);
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Failed to sync GSTR-2B via TaxPro' });
  }
}

export async function uploadGstr2bJson(req: Request, res: Response) {
  const payload = req.body.jsonData || req.body;
  if (!payload || (typeof payload !== 'object' && typeof payload !== 'string')) {
    return res.status(400).json({ error: 'Valid GSTR-2B JSON payload is required' });
  }

  try {
    const jsonObj = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const parsed = Gstr2bReconciliationService.parseGstr2bJson(jsonObj);
    const period = String(req.body.period || parsed.period || '').replace(/[^0-9]/g, '');

    if (period.length !== 6) {
      return res.status(400).json({
        error: 'Unable to detect return period from JSON. Please specify 6-digit period (e.g. 082026)',
      });
    }

    const saved = await Gstr2bReconciliationService.saveGstr2bImport(period, 'JSON_UPLOAD', parsed.entries);
    return res.json({
      success: true,
      ...saved,
      message: `Imported ${saved.totalInvoices} GSTR-2B invoices for period ${period}`,
    });
  } catch (err: any) {
    return res.status(400).json({ error: `Failed to parse GSTR-2B JSON: ${err.message}` });
  }
}

export async function getReconciliation(req: Request, res: Response) {
  let period = String(req.query.period || '').replace(/[^0-9]/g, '');
  if (period.length !== 6) {
    // Default to previous month
    const now = new Date();
    now.setMonth(now.getMonth() - 1);
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const y = now.getFullYear();
    period = `${m}${y}`;
  }

  try {
    const summary = await Gstr2bReconciliationService.reconcile(period);
    return res.json(summary);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to compute GSTR-2B reconciliation' });
  }
}

export async function getImportedPeriods(_req: Request, res: Response) {
  try {
    const imports = await prisma.gstr2bImport.findMany({
      orderBy: { financialPeriod: 'desc' },
      select: {
        id: true,
        financialPeriod: true,
        financialYear: true,
        month: true,
        year: true,
        importSource: true,
        totalInvoices: true,
        totalTaxable: true,
        totalItc: true,
        uploadedAt: true,
      },
    });

    return res.json(imports);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to load imported periods' });
  }
}

export async function deleteImport(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await prisma.gstr2bImport.delete({ where: { id } });
    return res.json({ success: true, message: 'GSTR-2B import statement removed' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to delete import' });
  }
}
