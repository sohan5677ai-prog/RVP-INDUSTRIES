import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { verifyAuditChain, recordAudit } from '../services/audit.service.js';
import { raiseAlert, resolveAlerts } from '../services/securityAlert.service.js';
import {
  evaluateAll,
  thresholdsFromEnv,
  SELF_RESOLVING,
  type Signals,
} from '../services/securityRules.js';

/**
 * The thing that notices (Phase 8).
 *
 * ---------------------------------------------------------------------------
 * Three times in this project something was quietly wrong and was found only
 * because somebody went looking: the storage bucket filling until it passed
 * its quota, the audit chain broken for two days, and the nightly backup not
 * running for a week. None of those were hard to detect. Nothing was looking.
 *
 * This looks, hourly, and writes what it finds somewhere a person will see.
 * ---------------------------------------------------------------------------
 *
 * Hourly rather than every few minutes because the chain check reads every
 * audit row, and because none of these conditions needs a five-minute
 * response - the point is that they are noticed at all, within the hour,
 * rather than in a fortnight.
 */

const ENABLED = process.env.SECURITY_MONITOR_ENABLED !== 'false';

/** How far back the event rules look. Comfortably more than the interval. */
const EVENT_LOOKBACK_MINUTES = 90;

async function gatherSignals(now: Date): Promise<Signals> {
  const since = new Date(now.getTime() - 24 * 3600_000);
  const eventsSince = new Date(now.getTime() - EVENT_LOOKBACK_MINUTES * 60_000);

  const [recentLogins, recentAudit, chainReport, lastBackup] = await Promise.all([
    prisma.loginAttempt.findMany({
      where: { createdAt: { gte: since } },
      select: { username: true, ip: true, outcome: true, createdAt: true },
      take: 5000,
    }),
    prisma.auditLog.findMany({
      where: {
        createdAt: { gte: eventsSince },
        action: { in: ['user.update', 'user.create', 'data.bulk_read'] },
      },
      select: { action: true, entityLabel: true, userName: true, oldValues: true, newValues: true, createdAt: true },
      take: 2000,
    }),
    verifyAuditChain(),
    // The backup runs on an office PC and writes to OneDrive, which this
    // process cannot see; it leaves a backup.taken row instead. See
    // services/backupHeartbeat.service.ts.
    prisma.auditLog.findFirst({
      where: { action: 'backup.taken' },
      orderBy: { seq: 'desc' },
      select: { createdAt: true },
    }),
  ]);

  return {
    recentLogins: recentLogins.map((l) => ({ ...l, outcome: String(l.outcome) })),
    recentAudit,
    chain: { ok: chainReport.ok, checked: chainReport.checked, failures: chainReport.failures.length },
    lastBackupAt: lastBackup?.createdAt ?? null,
  };
}

export async function runSecurityMonitor(now: Date = new Date()): Promise<{
  raised: number;
  resolved: number;
}> {
  const thresholds = thresholdsFromEnv();
  const signals = await gatherSignals(now);
  const alerts = evaluateAll(signals, thresholds, now);

  let raised = 0;
  for (const a of alerts) {
    const result = await raiseAlert({
      rule: a.rule,
      subject: a.subject,
      severity: a.severity,
      title: a.title,
      detail: a.detail as never,
    });
    if (result?.isNew) raised++;
  }

  // Clear the state rules whose condition has gone away. Without this a
  // broken chain that was repaired last week still shows as broken, and a
  // page of problems that are no longer true is a page nobody reads.
  let resolved = 0;
  const firing = new Set(alerts.map((a) => a.rule));
  for (const rule of SELF_RESOLVING) {
    if (!firing.has(rule)) resolved += await resolveAlerts(rule);
  }

  await recordChainHeartbeat(signals, now);

  if (raised > 0 || resolved > 0) {
    logger.info(`[security-monitor] raised ${raised}, cleared ${resolved}`);
  }
  return { raised, resolved };
}

/**
 * Leave a record that the chain was checked, so the page can tell "verified
 * and fine" from "never checked".
 *
 * Not every run: hourly would add 8,760 rows a year to the trail this is
 * meant to keep readable, which is the mistake made twice already. Once every
 * twelve hours is enough for a heartbeat - and a FAILURE is recorded
 * immediately, because that one is evidence rather than a heartbeat.
 */
const CHAIN_HEARTBEAT_HOURS = 12;

async function recordChainHeartbeat(signals: Signals, now: Date): Promise<void> {
  try {
    if (signals.chain.ok) {
      const last = await prisma.auditLog.findFirst({
        where: { action: 'audit.verify' },
        orderBy: { seq: 'desc' },
        select: { createdAt: true },
      });
      const hours = last ? (now.getTime() - last.createdAt.getTime()) / 3600_000 : Infinity;
      if (hours < CHAIN_HEARTBEAT_HOURS) return;
    }
    await recordAudit({
      action: 'audit.verify',
      newValues: {
        ok: signals.chain.ok,
        checked: signals.chain.checked,
        failures: signals.chain.failures,
        by: 'security-monitor',
      },
    });
  } catch (err) {
    logger.warn('[security-monitor] could not record the chain check', err);
  }
}

export function registerSecurityMonitorCron(): void {
  if (!ENABLED) {
    logger.info('[security-monitor] disabled (SECURITY_MONITOR_ENABLED=false)');
    return;
  }

  // Seven minutes past, so it does not land with every other hourly thing.
  cron.schedule(
    '7 * * * *',
    () => {
      runSecurityMonitor().catch((err) =>
        // A monitor that takes the application down with it is worse than the
        // condition it was watching for.
        logger.error('[security-monitor] run failed:', err)
      );
    },
    { timezone: 'Asia/Kolkata' }
  );

  logger.info('[security-monitor] scheduled hourly at :07 IST');

  // One run shortly after boot, so a deploy does not leave a gap of up to an
  // hour, and so a newly deployed instance says what it can see straight away.
  setTimeout(() => {
    runSecurityMonitor().catch((err) => logger.error('[security-monitor] first run failed:', err));
  }, 60_000).unref();
}
