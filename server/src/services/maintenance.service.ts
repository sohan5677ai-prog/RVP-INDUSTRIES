import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

export interface MaintenanceStatusResult {
  enabled: boolean;
  isUnderMaintenance: boolean;
  title: string;
  message: string;
  startedAt: string | null;
  endsAt: string | null;
  secondsLeft: number;
  durationMinutes: number;
  contactInfo: string | null;
  updatedAt: string;
  updatedByName?: string | null;
}

interface CachedConfig {
  id: number;
  enabled: boolean;
  title: string;
  message: string;
  startedAt: Date;
  endsAt: Date | null;
  durationMinutes: number;
  scope: string;
  contactInfo: string | null;
  updatedById: string | null;
  updatedByName: string | null;
  createdAt: Date;
  updatedAt: Date;
  cachedAt: number;
}

// In-memory cache with 10-second safety TTL so database hits are avoided on high-concurrency checks
let cachedMaintenance: CachedConfig | null = null;
const CACHE_TTL_MS = 10_000;

export function invalidateMaintenanceCache() {
  cachedMaintenance = null;
}

/**
 * Fetch the singleton maintenance config from DB (or memory cache)
 */
export async function getMaintenanceConfigRecord(): Promise<CachedConfig> {
  const now = Date.now();
  if (cachedMaintenance && now - cachedMaintenance.cachedAt < CACHE_TTL_MS) {
    return cachedMaintenance;
  }

  try {
    let row = await prisma.maintenanceConfig.findUnique({
      where: { id: 1 },
    });

    if (!row) {
      row = await prisma.maintenanceConfig.create({
        data: {
          id: 1,
          enabled: false,
          title: 'System Maintenance in Progress',
          message:
            'We are performing essential system maintenance and database optimization. The ERP will be back online shortly.',
          startedAt: new Date(),
          endsAt: null,
          durationMinutes: 10,
          contactInfo: 'Developer / Tech Support Team',
        },
      });
    }

    cachedMaintenance = {
      ...row,
      cachedAt: now,
    };
    return cachedMaintenance;
  } catch (err) {
    logger.error('[maintenance.service] error fetching maintenance config', err);
    // Return safe fallback if DB is unreachable
    if (cachedMaintenance) return cachedMaintenance;
    return {
      id: 1,
      enabled: false,
      title: 'System Maintenance in Progress',
      message: 'System maintenance is temporarily active.',
      startedAt: new Date(),
      endsAt: null,
      durationMinutes: 10,
      scope: 'FULL',
      contactInfo: 'Developer / Tech Support',
      updatedById: null,
      updatedByName: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      cachedAt: now,
    };
  }
}

/**
 * Check if maintenance is currently active.
 * Auto-expires if endsAt is in the past!
 */
export function isMaintenanceActive(config: CachedConfig): boolean {
  if (!config.enabled) return false;
  if (config.endsAt) {
    const endsTime = new Date(config.endsAt).getTime();
    if (Date.now() >= endsTime) {
      return false; // Auto-expired
    }
  }
  return true;
}

/**
 * Calculate formatted status with live secondsLeft
 */
export function formatMaintenanceStatus(config: CachedConfig): MaintenanceStatusResult {
  const isUnderMaintenance = isMaintenanceActive(config);
  let secondsLeft = 0;

  if (isUnderMaintenance && config.endsAt) {
    const diff = Math.floor((new Date(config.endsAt).getTime() - Date.now()) / 1000);
    secondsLeft = Math.max(0, diff);
  }

  return {
    enabled: config.enabled,
    isUnderMaintenance,
    title: config.title || 'System Maintenance in Progress',
    message:
      config.message ||
      'We are performing essential system maintenance and database optimization. The ERP will be back online shortly.',
    startedAt: config.startedAt ? config.startedAt.toISOString() : null,
    endsAt: config.endsAt ? config.endsAt.toISOString() : null,
    secondsLeft,
    durationMinutes: config.durationMinutes || 10,
    contactInfo: config.contactInfo,
    updatedAt: config.updatedAt ? config.updatedAt.toISOString() : new Date().toISOString(),
    updatedByName: config.updatedByName,
  };
}

/**
 * Get current public / live maintenance status
 */
export async function getMaintenanceStatus(): Promise<MaintenanceStatusResult> {
  const config = await getMaintenanceConfigRecord();
  return formatMaintenanceStatus(config);
}

/**
 * Update maintenance configuration (Developer Only)
 */
export async function updateMaintenanceConfig(
  input: {
    enabled?: boolean;
    title?: string;
    message?: string;
    durationMinutes?: number;
    contactInfo?: string;
  },
  user?: { id?: string; name?: string }
): Promise<MaintenanceStatusResult> {
  const existing = await getMaintenanceConfigRecord();
  const enabled = input.enabled !== undefined ? input.enabled : existing.enabled;
  const duration = Math.max(1, Math.min(1440, input.durationMinutes ?? existing.durationMinutes ?? 10));
  const title = input.title !== undefined ? input.title.trim() : existing.title;
  const message = input.message !== undefined ? input.message.trim() : existing.message;
  const contactInfo = input.contactInfo !== undefined ? input.contactInfo.trim() : existing.contactInfo;

  let startedAt = existing.startedAt;
  let endsAt = existing.endsAt;

  if (input.enabled === true) {
    startedAt = new Date();
    endsAt = new Date(Date.now() + duration * 60 * 1000);
  } else if (input.enabled === false) {
    endsAt = null;
  } else if (enabled && input.durationMinutes !== undefined) {
    // Updating duration while enabled
    endsAt = new Date(Date.now() + duration * 60 * 1000);
  }

  const updated = await prisma.maintenanceConfig.upsert({
    where: { id: 1 },
    update: {
      enabled,
      title,
      message,
      startedAt,
      endsAt,
      durationMinutes: duration,
      contactInfo,
      updatedById: user?.id ?? null,
      updatedByName: user?.name ?? null,
    },
    create: {
      id: 1,
      enabled,
      title,
      message,
      startedAt,
      endsAt,
      durationMinutes: duration,
      contactInfo,
      updatedById: user?.id ?? null,
      updatedByName: user?.name ?? null,
    },
  });

  cachedMaintenance = {
    ...updated,
    cachedAt: Date.now(),
  };

  logger.info(
    `[maintenance] config updated by ${user?.name ?? 'developer'}: enabled=${enabled}, duration=${duration}m, endsAt=${endsAt?.toISOString()}`
  );

  return formatMaintenanceStatus(cachedMaintenance);
}

/**
 * Extend active maintenance duration by extra minutes
 */
export async function extendMaintenanceDuration(
  extraMinutes: number,
  user?: { id?: string; name?: string }
): Promise<MaintenanceStatusResult> {
  const existing = await getMaintenanceConfigRecord();
  const safeExtra = Math.max(1, Math.min(360, extraMinutes));

  const currentBase =
    existing.endsAt && existing.endsAt.getTime() > Date.now()
      ? existing.endsAt.getTime()
      : Date.now();

  const newEndsAt = new Date(currentBase + safeExtra * 60 * 1000);
  const totalDurationMinutes = Math.max(
    1,
    Math.round((newEndsAt.getTime() - (existing.startedAt?.getTime() || Date.now())) / (60 * 1000))
  );

  const updated = await prisma.maintenanceConfig.update({
    where: { id: 1 },
    data: {
      enabled: true,
      endsAt: newEndsAt,
      durationMinutes: totalDurationMinutes,
      updatedById: user?.id ?? null,
      updatedByName: user?.name ?? null,
    },
  });

  cachedMaintenance = {
    ...updated,
    cachedAt: Date.now(),
  };

  logger.info(
    `[maintenance] duration extended by +${safeExtra}m by ${user?.name ?? 'developer'}, new endsAt=${newEndsAt.toISOString()}`
  );

  return formatMaintenanceStatus(cachedMaintenance);
}

/**
 * Immediately turn off maintenance mode
 */
export async function endMaintenanceMode(
  user?: { id?: string; name?: string }
): Promise<MaintenanceStatusResult> {
  return updateMaintenanceConfig({ enabled: false }, user);
}
