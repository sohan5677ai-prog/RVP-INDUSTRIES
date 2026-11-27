import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/httpError.js';
import { acknowledgeAlert } from '../services/securityAlert.service.js';
import { runSecurityMonitor } from '../jobs/securityMonitorJob.js';
import { thresholdsFromEnv } from '../services/securityRules.js';

/**
 * What the security page reads (Phase 8).
 *
 * Two endpoints rather than one, because they answer two different questions.
 * `/alerts` is "what needs attention"; `/overview` is "what is the state of
 * the things that are supposed to be protecting us" - the backup, the chain,
 * the monitor itself. The second matters because every failure this phase was
 * built for was a safeguard that had quietly stopped working.
 */

export async function listSecurityAlerts(req: Request, res: Response) {
  const includeAcknowledged = req.query.includeAcknowledged === 'true';
  const alerts = await prisma.securityAlert.findMany({
    where: includeAcknowledged ? {} : { acknowledgedAt: null },
    orderBy: [{ acknowledgedAt: 'asc' }, { severity: 'desc' }, { lastSeenAt: 'desc' }],
    take: 200,
  });
  res.json(alerts);
}

export async function acknowledgeSecurityAlert(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  const { note } = z.object({ note: z.string().max(500).optional() }).parse(req.body ?? {});

  const alert = await prisma.securityAlert.findUnique({ where: { id: req.params.id } });
  if (!alert) throw new HttpError(404, 'No such alert');
  if (alert.acknowledgedAt) throw new HttpError(409, 'That alert is already acknowledged.');

  const actor = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { name: true },
  });
  await acknowledgeAlert({
    id: alert.id,
    userId: req.user.userId,
    userName: actor?.name ?? null,
    note: note ?? null,
  });
  res.json({ ok: true });
}

/**
 * The state of the safeguards.
 *
 * Deliberately shows the *last run* of each watcher as well as its result: a
 * check that has not run is not the same as a check that passed, and telling
 * them apart is the whole lesson of this phase.
 */
export async function securityOverview(_req: Request, res: Response) {
  const since7d = new Date(Date.now() - 7 * 864e5);
  const since24h = new Date(Date.now() - 864e5);

  const [failed7d, failed24h, denials7d, lastBackup, lastChainCheck, lastPrune, openCount, criticalCount] =
    await Promise.all([
      prisma.loginAttempt.count({ where: { outcome: { not: 'SUCCESS' }, createdAt: { gte: since7d } } }),
      prisma.loginAttempt.count({ where: { outcome: { not: 'SUCCESS' }, createdAt: { gte: since24h } } }),
      prisma.permissionDenial.count({ where: { createdAt: { gte: since7d } } }),
      prisma.auditLog.findFirst({
        where: { action: 'backup.taken' },
        orderBy: { seq: 'desc' },
        select: { createdAt: true, newValues: true },
      }),
      prisma.auditLog.findFirst({
        where: { action: 'audit.verify' },
        orderBy: { seq: 'desc' },
        select: { createdAt: true, newValues: true },
      }),
      prisma.auditLog.findFirst({
        where: { action: 'storage.prune' },
        orderBy: { seq: 'desc' },
        select: { createdAt: true, entityLabel: true },
      }),
      prisma.securityAlert.count({ where: { acknowledgedAt: null } }),
      prisma.securityAlert.count({ where: { acknowledgedAt: null, severity: 'CRITICAL' } }),
    ]);

  res.json({
    openAlerts: openCount,
    criticalAlerts: criticalCount,
    failedLogins7d: failed7d,
    failedLogins24h: failed24h,
    permissionDenials7d: denials7d,
    lastBackup: lastBackup
      ? { at: lastBackup.createdAt, detail: lastBackup.newValues }
      : null,
    lastChainCheck: lastChainCheck
      ? { at: lastChainCheck.createdAt, detail: lastChainCheck.newValues }
      : null,
    lastStoragePrune: lastPrune
      ? { at: lastPrune.createdAt, summary: lastPrune.entityLabel }
      : null,
    thresholds: thresholdsFromEnv(),
    // So the page can say "alerts are stored but email goes nowhere" rather
    // than letting that stay invisible, which is how it stayed unset.
    alertEmailConfigured: Boolean(
      (await prisma.companyProfile.findFirst({ select: { securityAlertEmails: true } }))
        ?.securityAlertEmails?.trim()
    ),
  });
}

/** Run the checks now, so the page has a button rather than an hour's wait. */
export async function runSecurityChecks(_req: Request, res: Response) {
  res.json(await runSecurityMonitor());
}
