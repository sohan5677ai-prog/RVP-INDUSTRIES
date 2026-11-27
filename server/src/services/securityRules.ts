import { istHour24 } from '../lib/istDate.js';

/**
 * The checks, as pure decisions (Phase 8).
 *
 * ---------------------------------------------------------------------------
 * Why these are separate from the job that runs them
 *
 * Each rule here takes the signals it needs and returns the alerts it wants
 * raised. No database, no clock of its own, no email. That makes the part
 * that decides testable on its own, which matters because the failure mode of
 * a monitoring system is not crashing - it is being quietly wrong, firing on
 * nothing or staying silent through the thing it was built for.
 *
 * "Configurable rules" here means thresholds, not a rule builder. A DSL is a
 * great deal of surface for something one person will ever configure, and it
 * is the thresholds that actually need tuning - as the 500-row bulk-read
 * default demonstrated by filling 19% of the audit trail.
 * ---------------------------------------------------------------------------
 */

export interface RuleAlert {
  rule: string;
  subject?: string | null;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  detail?: Record<string, unknown>;
}

export interface Thresholds {
  /** Failed logins for one username before it is worth saying something. */
  failedLoginsPerUser: number;
  /** Failed logins from one IP, which is the credential-stuffing shape. */
  failedLoginsPerIp: number;
  /** The window both of those are counted over, in minutes. */
  failedLoginWindowMinutes: number;
  /** Rows in one read that count as a large export. */
  largeExportRows: number;
  /** Hours after which no successful backup is a problem. */
  backupStaleHours: number;
  /** IST hours considered "odd" - inclusive start, exclusive end. */
  oddHourStart: number;
  oddHourEnd: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  failedLoginsPerUser: 5,
  failedLoginsPerIp: 10,
  failedLoginWindowMinutes: 30,
  // Above the two pages that routinely return ~550 and ~675 rows, so the
  // register dumps stand out instead of being buried by ordinary use.
  largeExportRows: 1000,
  // A day and a half: one missed night is a PC that was asleep, two is a
  // backup that has stopped.
  backupStaleHours: 36,
  oddHourStart: 23,
  oddHourEnd: 5,
};

export function thresholdsFromEnv(env: NodeJS.ProcessEnv = process.env): Thresholds {
  const num = (key: string, fallback: number) => {
    const v = Number(env[key]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    failedLoginsPerUser: num('ALERT_FAILED_LOGINS_USER', DEFAULT_THRESHOLDS.failedLoginsPerUser),
    failedLoginsPerIp: num('ALERT_FAILED_LOGINS_IP', DEFAULT_THRESHOLDS.failedLoginsPerIp),
    failedLoginWindowMinutes: num('ALERT_FAILED_LOGIN_WINDOW_MIN', DEFAULT_THRESHOLDS.failedLoginWindowMinutes),
    largeExportRows: num('ALERT_LARGE_EXPORT_ROWS', DEFAULT_THRESHOLDS.largeExportRows),
    backupStaleHours: num('ALERT_BACKUP_STALE_HOURS', DEFAULT_THRESHOLDS.backupStaleHours),
    oddHourStart: num('ALERT_ODD_HOUR_START', DEFAULT_THRESHOLDS.oddHourStart),
    oddHourEnd: num('ALERT_ODD_HOUR_END', DEFAULT_THRESHOLDS.oddHourEnd),
  };
}

/* ------------------------------------------------------------- signals -- */

export interface LoginSignal {
  username: string;
  ip: string | null;
  outcome: string;
  createdAt: Date;
}

export interface AuditSignal {
  action: string;
  entityLabel: string | null;
  userName: string | null;
  /** Needed to tell a role *change* from a row that merely mentions a role. */
  oldValues: unknown;
  newValues: unknown;
  createdAt: Date;
}

export interface Signals {
  recentLogins: LoginSignal[];
  recentAudit: AuditSignal[];
  chain: { ok: boolean; checked: number; failures: number };
  /** When the newest backup was taken, or null if there is none at all. */
  lastBackupAt: Date | null;
}

/* --------------------------------------------------------------- rules -- */

/**
 * A burst of failed logins against one account, or from one address.
 *
 * Counted per username *and* per IP because they are different attacks: one
 * account under a dictionary, versus one address working through a list of
 * accounts. A rule that only counted per user would miss the second entirely.
 */
export function failedLoginBursts(signals: Signals, t: Thresholds, now: Date): RuleAlert[] {
  const since = now.getTime() - t.failedLoginWindowMinutes * 60_000;
  const failures = signals.recentLogins.filter(
    (l) => l.outcome !== 'SUCCESS' && l.createdAt.getTime() >= since
  );

  const out: RuleAlert[] = [];
  const byUser = new Map<string, number>();
  const byIp = new Map<string, number>();
  for (const f of failures) {
    byUser.set(f.username, (byUser.get(f.username) ?? 0) + 1);
    if (f.ip) byIp.set(f.ip, (byIp.get(f.ip) ?? 0) + 1);
  }

  for (const [username, count] of byUser) {
    if (count >= t.failedLoginsPerUser) {
      out.push({
        rule: 'login.failed_burst_user',
        subject: username,
        severity: 'WARNING',
        title: `${count} failed sign-ins for "${username}" in ${t.failedLoginWindowMinutes} minutes`,
        detail: { username, count, windowMinutes: t.failedLoginWindowMinutes },
      });
    }
  }
  for (const [ip, count] of byIp) {
    if (count >= t.failedLoginsPerIp) {
      out.push({
        rule: 'login.failed_burst_ip',
        subject: ip,
        severity: 'WARNING',
        title: `${count} failed sign-ins from ${ip} in ${t.failedLoginWindowMinutes} minutes`,
        detail: { ip, count, windowMinutes: t.failedLoginWindowMinutes },
      });
    }
  }
  return out;
}

/**
 * A successful sign-in in the middle of the night, IST.
 *
 * INFO rather than WARNING: the mill runs long days and a genuine late login
 * is ordinary. It is worth being able to see, not worth waking anyone.
 */
export function oddHourLogins(signals: Signals, t: Thresholds, now: Date): RuleAlert[] {
  const since = now.getTime() - 24 * 3600_000;
  const out: RuleAlert[] = [];
  const seen = new Set<string>();

  for (const l of signals.recentLogins) {
    if (l.outcome !== 'SUCCESS' || l.createdAt.getTime() < since) continue;
    const hour = istHour24(l.createdAt);
    const odd =
      t.oddHourStart > t.oddHourEnd
        ? hour >= t.oddHourStart || hour < t.oddHourEnd
        : hour >= t.oddHourStart && hour < t.oddHourEnd;
    if (!odd || seen.has(l.username)) continue;
    seen.add(l.username);
    out.push({
      rule: 'login.odd_hour',
      subject: l.username,
      severity: 'INFO',
      title: `"${l.username}" signed in at ${String(hour).padStart(2, '0')}:00 IST`,
      detail: { username: l.username, hourIst: hour, ip: l.ip },
    });
  }
  return out;
}

const PRIVILEGED = ['OWNER', 'ADMIN', 'DEVELOPER'];

/**
 * A role actually CHANGING, or an account appearing with a privileged role.
 *
 * The first version of this fired whenever a `user.update` row *mentioned* a
 * privileged role - and the audit row carries the whole user record, so every
 * login by an owner raised a "privilege change". It was raising alerts about
 * `lastLoginAt` within hours of deploying, which is the noise failure this
 * phase was written to avoid, committed by this phase.
 *
 * So it compares the before and after. A row where the role is the same is not
 * a role change, whatever else it touched.
 */
export function privilegeChanges(signals: Signals): RuleAlert[] {
  const out: RuleAlert[] = [];
  for (const a of signals.recentAudit) {
    const after = (a.newValues ?? {}) as Record<string, unknown>;
    const before = (a.oldValues ?? {}) as Record<string, unknown>;
    const role = typeof after.role === 'string' ? after.role : null;
    const wasRole = typeof before.role === 'string' ? before.role : null;
    const who = String(after.username ?? a.entityLabel ?? 'unknown');

    if (a.action === 'user.create') {
      if (!role || !PRIVILEGED.includes(role)) continue;
      out.push({
        rule: 'user.privileged_change',
        subject: who,
        severity: 'WARNING',
        title: `New ${role} account: ${who}`,
        detail: { role, by: a.userName, action: a.action },
      });
      continue;
    }

    if (a.action !== 'user.update') continue;
    // The whole point: unchanged is not a change.
    if (!role || !wasRole || role === wasRole) continue;
    // A demotion out of a privileged role is as notable as a promotion into
    // one - someone losing ADMIN unexpectedly is worth seeing too.
    if (!PRIVILEGED.includes(role) && !PRIVILEGED.includes(wasRole)) continue;

    out.push({
      rule: 'user.privileged_change',
      subject: who,
      severity: 'WARNING',
      title: `${who} changed from ${wasRole} to ${role}`,
      detail: { from: wasRole, to: role, by: a.userName },
    });
  }
  return out;
}

/** A read large enough to be an export of a whole register. */
export function largeExports(signals: Signals, t: Thresholds): RuleAlert[] {
  const out: RuleAlert[] = [];
  for (const a of signals.recentAudit) {
    if (a.action !== 'data.bulk_read') continue;
    const v = (a.newValues ?? {}) as Record<string, unknown>;
    const rows = typeof v.rows === 'number' ? v.rows : 0;
    if (rows < t.largeExportRows) continue;
    out.push({
      rule: 'data.large_export',
      subject: typeof v.path === 'string' ? v.path : null,
      severity: 'INFO',
      title: `${rows} rows read from ${v.path} by ${a.userName ?? 'unknown'}`,
      detail: { path: v.path, rows, by: a.userName },
    });
  }
  return out;
}

/**
 * The audit chain failing to verify.
 *
 * CRITICAL, and auto-resolving: this describes a state, not an event. When
 * the chain verifies again the alert should clear itself - a page full of
 * problems that were fixed last week is a page nobody reads.
 */
export function chainIntegrity(signals: Signals): RuleAlert[] {
  if (signals.chain.ok) return [];
  return [
    {
      rule: 'audit.chain_broken',
      subject: null,
      severity: 'CRITICAL',
      title: `The audit chain does not verify: ${signals.chain.failures} problem(s) in ${signals.chain.checked} rows`,
      detail: {
        failures: signals.chain.failures,
        checked: signals.chain.checked,
        whatToDo: 'See docs/security/RUNBOOK.md - "Reading a break".',
      },
    },
  ];
}

/**
 * No recent backup.
 *
 * Not in the plan's list. It is here because the backup stopped for a week
 * and nobody knew - which is the failure this whole phase is meant to end.
 */
export function backupFreshness(signals: Signals, t: Thresholds, now: Date): RuleAlert[] {
  if (!signals.lastBackupAt) {
    return [
      {
        rule: 'backup.missing',
        subject: null,
        severity: 'CRITICAL',
        title: 'There is no database backup at all',
        detail: { whatToDo: 'docs/security/RUNBOOK.md - Backups' },
      },
    ];
  }
  const hours = (now.getTime() - signals.lastBackupAt.getTime()) / 3600_000;
  if (hours < t.backupStaleHours) return [];
  return [
    {
      rule: 'backup.stale',
      subject: null,
      severity: 'CRITICAL',
      title: `The last database backup was ${Math.floor(hours / 24)} day(s) ago`,
      detail: {
        lastBackupAt: signals.lastBackupAt.toISOString(),
        hoursOld: Math.round(hours),
        whatToDo: 'Check the "RVP Database Backup" scheduled task is registered and the PC is on.',
      },
    },
  ];
}

/** Rules whose alerts clear themselves once the condition goes away. */
export const SELF_RESOLVING = ['audit.chain_broken', 'backup.stale', 'backup.missing'] as const;

export function evaluateAll(signals: Signals, t: Thresholds, now: Date): RuleAlert[] {
  return [
    ...failedLoginBursts(signals, t, now),
    ...oddHourLogins(signals, t, now),
    ...privilegeChanges(signals),
    ...largeExports(signals, t),
    ...chainIntegrity(signals),
    ...backupFreshness(signals, t, now),
  ];
}
