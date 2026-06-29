import type { Request, Response } from 'express';
import { AllocationService } from '../services/allocation.service.js';

/**
 * GET /api/allocation-health
 *
 * Returns the full allocation health dashboard data: PO utilization, risk
 * levels, soft/hard/bumped breakdown, unallocated sale orders, and variance
 * tracking for arrived POs.
 */
export async function getAllocationHealth(_req: Request, res: Response) {
  const health = await AllocationService.getAllocationHealth();
  res.json(health);
}
