import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';
import {
  getMaintenanceConfigRecord,
  isMaintenanceActive,
  formatMaintenanceStatus,
} from '../services/maintenance.service.js';

/**
 * Backend Maintenance Gate.
 * Blocks all non-DEVELOPER requests when maintenance mode is active.
 *
 * - The DEVELOPER role always bypasses so they can test and manage system configuration.
 * - Non-developers (ADMIN, OWNER, USER) receive a structured 503 response with the live timer and message.
 */
export async function maintenanceGate(req: Request, res: Response, next: NextFunction) {
  // Developer account always passes
  if (req.user?.role === 'DEVELOPER') return next();

  try {
    const config = await getMaintenanceConfigRecord();
    if (isMaintenanceActive(config)) {
      const status = formatMaintenanceStatus(config);
      res.setHeader('X-Maintenance-Mode', '1');
      res.setHeader('Retry-After', String(Math.max(5, Math.min(60, status.secondsLeft || 30))));
      return res.status(503).json({
        code: 'MAINTENANCE_MODE',
        error: status.message || 'System is currently under maintenance.',
        maintenance: status,
      });
    }
  } catch (err) {
    // Fail open if maintenance check errors so unexpected outages don't hard-brick the API
    logger.error('maintenanceGate error:', err);
  }

  next();
}
