import type { AlertSeverity, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { recordAudit } from './audit.service.js';

/**
 * Raising and closing security alerts (Phase 8).
 *
 * ---------------------------------------------------------------------------
 * Stored first, emailed second
 *
 * `securityAlertEmails` sat unset for months. An email-only engine would have
 * shipped and alerted nobody, which is the exact shape of failure this phase
 * exists to end - the storage quota and the stale backup were both found by
 * someone going to look, not by being told.
 *
 * So an alert is a row. The page shows it whatever the mail configuration is
 * doing, and email is an additional channel that announces its own absence at
 * startup rather than failing quietly.
 * ---------------------------------------------------------------------------
 *
 * One OPEN alert per (rule, subject). A repeat bumps `occurrences` and
 * `lastSeenAt` rather than adding a row, because a check that runs every
 * fifteen minutes would otherwise produce ninety-six alerts a day about one
 * problem - which is how 61% of the audit trail became restart noise and 19%
 * of it bulk-read entries. The counter is the useful part anyway: "47 times
 * since Tuesday" says more than forty-seven identical rows.
 */

export interface RaiseAlert {
  rule: string;
  /** Username, IP, path - whatever the alert is *about*. Null for system-wide. */
  subject?: string | null;
  severity?: AlertSeverity;
  title: string;
  detail?: Prisma.InputJsonValue;
}

export interface RaiseResult {
  id: string;
  isNew: boolean;
  occurrences: number;
}

/**
 * Raise an alert, or fold it into the open one for the same rule and subject.
 *
 * Never throws. A monitoring check that takes the application down with it is
 * worse than the condition it was watching for.
 */
export async function raiseAlert(input: RaiseAlert): Promise<RaiseResult | null> {
  const subject = input.subject ?? null;
  try {
    const open = await prisma.securityAlert.findFirst({
      where: { rule: input.rule, subject, acknowledgedAt: null },
      orderBy: { lastSeenAt: 'desc' },
    });

    if (open) {
      const updated = await prisma.securityAlert.update({
        where: { id: open.id },
        data: {
          lastSeenAt: new Date(),
          occurrences: { increment: 1 },
          // The newest detail replaces the old: "12 failed logins" is more
          // useful than whatever it said the first time.
          detail: input.detail ?? open.detail ?? undefined,
          // A repeat that is worse than before should show as worse.
          severity: rank(input.severity) > rank(open.severity) ? input.severity : open.severity,
          title: input.title,
        },
      });
      return { id: updated.id, isNew: false, occurrences: updated.occurrences };
    }

    const created = await prisma.securityAlert.create({
      data: {
        rule: input.rule,
        subject,
        severity: input.severity ?? 'WARNING',
        title: input.title,
        detail: input.detail,
      },
    });

    logger.warn(`[security-alert] ${created.severity} ${input.rule}: ${input.title}`);
    // Only a NEW alert is audited. Auditing every repeat would put the noise
    // straight back into the trail this is trying to keep readable.
    await recordAudit({
      action: 'security.alert',
      entity: 'SecurityAlert',
      entityId: created.id,
      entityLabel: input.title,
      newValues: { rule: input.rule, subject, severity: created.severity },
    });

    return { id: created.id, isNew: true, occurrences: 1 };
  } catch (err) {
    logger.error(`[security-alert] could not raise ${input.rule}`, err);
    return null;
  }
}

const ORDER: Record<string, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };
const rank = (s?: AlertSeverity | null): number => ORDER[s ?? 'WARNING'] ?? 1;

/**
 * Close an open alert because the condition has gone away.
 *
 * Used by the checks that describe a *state* rather than an event - a stale
 * backup, a broken chain. When the backup runs again the alert should clear
 * itself; leaving it open until someone clicks acknowledge would teach people
 * that the page is full of things that are no longer true.
 *
 * Event alerts - a failed-login burst - are deliberately NOT auto-closed. The
 * event happened, and a human should see it before it disappears.
 */
export async function resolveAlerts(rule: string, subject?: string | null): Promise<number> {
  try {
    const { count } = await prisma.securityAlert.updateMany({
      where: {
        rule,
        ...(subject === undefined ? {} : { subject: subject ?? null }),
        acknowledgedAt: null,
      },
      data: {
        acknowledgedAt: new Date(),
        acknowledgedByName: 'resolved automatically',
        acknowledgeNote: 'The condition cleared.',
      },
    });
    if (count > 0) logger.info(`[security-alert] ${rule} cleared (${count})`);
    return count;
  } catch (err) {
    logger.error(`[security-alert] could not resolve ${rule}`, err);
    return 0;
  }
}

export async function acknowledgeAlert(params: {
  id: string;
  userId: string;
  userName?: string | null;
  note?: string | null;
}): Promise<void> {
  await prisma.securityAlert.update({
    where: { id: params.id },
    data: {
      acknowledgedAt: new Date(),
      acknowledgedById: params.userId,
      acknowledgedByName: params.userName ?? null,
      acknowledgeNote: params.note ?? null,
    },
  });
  await recordAudit({
    action: 'security.alert.acknowledge',
    entity: 'SecurityAlert',
    entityId: params.id,
    newValues: { note: params.note ?? null },
  });
}

export function openAlerts(limit = 100) {
  return prisma.securityAlert.findMany({
    where: { acknowledgedAt: null },
    orderBy: [{ severity: 'desc' }, { lastSeenAt: 'desc' }],
    take: limit,
  });
}
