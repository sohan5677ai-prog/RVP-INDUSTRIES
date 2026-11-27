/**
 * The monitoring rules (Phase 8).
 *
 * A monitoring system does not fail by crashing - it fails by being quietly
 * wrong: firing on nothing until people stop reading it, or staying silent
 * through the exact thing it was built for. Both halves are tested here, and
 * the silence cases are the ones that matter.
 */
import { describe, it, expect } from 'vitest';
import {
  failedLoginBursts,
  oddHourLogins,
  privilegeChanges,
  largeExports,
  chainIntegrity,
  backupFreshness,
  evaluateAll,
  thresholdsFromEnv,
  DEFAULT_THRESHOLDS,
  type Signals,
} from './securityRules.js';
import { istHour24 } from '../lib/istDate.js';

const T = DEFAULT_THRESHOLDS;
const NOW = new Date('2026-11-27T12:00:00Z'); // 17:30 IST
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const signals = (over: Partial<Signals> = {}): Signals => ({
  recentLogins: [],
  recentAudit: [],
  chain: { ok: true, checked: 1613, failures: 0 },
  lastBackupAt: minsAgo(60),
  ...over,
});

const login = (over: Partial<Signals['recentLogins'][0]> = {}) => ({
  username: 'sohan',
  ip: '10.0.0.1',
  outcome: 'FAILED',
  createdAt: minsAgo(5),
  ...over,
});

describe('failed login bursts', () => {
  it('says nothing below the threshold', () => {
    const l = Array.from({ length: T.failedLoginsPerUser - 1 }, () => login());
    expect(failedLoginBursts(signals({ recentLogins: l }), T, NOW)).toEqual([]);
  });

  it('fires at the threshold, naming the account and the count', () => {
    const l = Array.from({ length: T.failedLoginsPerUser }, () => login());
    const [a] = failedLoginBursts(signals({ recentLogins: l }), T, NOW);
    expect(a.rule).toBe('login.failed_burst_user');
    expect(a.subject).toBe('sohan');
    expect(a.title).toContain(String(T.failedLoginsPerUser));
  });

  it('counts per IP as well, which is the other attack', () => {
    // One address working through a list of accounts never trips the
    // per-user rule. A check that only counted per user would miss it.
    const l = Array.from({ length: T.failedLoginsPerIp }, (_, i) =>
      login({ username: `user${i}`, ip: '203.0.113.9' })
    );
    const out = failedLoginBursts(signals({ recentLogins: l }), T, NOW);
    expect(out.some((a) => a.rule === 'login.failed_burst_ip' && a.subject === '203.0.113.9')).toBe(true);
    expect(out.some((a) => a.rule === 'login.failed_burst_user')).toBe(false);
  });

  it('ignores failures outside the window', () => {
    const old = Array.from({ length: 20 }, () => login({ createdAt: minsAgo(T.failedLoginWindowMinutes + 5) }));
    expect(failedLoginBursts(signals({ recentLogins: old }), T, NOW)).toEqual([]);
  });

  it('ignores successful sign-ins', () => {
    const ok = Array.from({ length: 20 }, () => login({ outcome: 'SUCCESS' }));
    expect(failedLoginBursts(signals({ recentLogins: ok }), T, NOW)).toEqual([]);
  });
});

describe('odd-hour logins', () => {
  /** A Date that is a given hour in IST, which is what the rule judges. */
  const atIstHour = (h: number) => {
    const d = new Date(Date.UTC(2026, 10, 27, (h - 5 + 24) % 24, 0, 0));
    d.setUTCMinutes(d.getUTCMinutes() - 30);
    return d;
  };

  it('fires for a sign-in at 2am IST', () => {
    const when = atIstHour(2);
    expect(istHour24(when)).toBe(2); // the fixture really is 2am IST
    const out = oddHourLogins(signals({ recentLogins: [login({ outcome: 'SUCCESS', createdAt: when })] }), T, NOW);
    expect(out[0]?.rule).toBe('login.odd_hour');
    expect(out[0]?.severity).toBe('INFO');
  });

  it('says nothing for a sign-in during the working day', () => {
    const when = atIstHour(14);
    expect(istHour24(when)).toBe(14);
    expect(oddHourLogins(signals({ recentLogins: [login({ outcome: 'SUCCESS', createdAt: when })] }), T, NOW)).toEqual([]);
  });

  it('reports a person once, not once per sign-in', () => {
    const when = atIstHour(2);
    const l = [0, 1, 2].map(() => login({ outcome: 'SUCCESS', createdAt: when }));
    expect(oddHourLogins(signals({ recentLogins: l }), T, NOW)).toHaveLength(1);
  });
});

describe('privilege changes', () => {
  const audit = (over = {}) => ({
    action: 'user.update',
    entityLabel: 'kiran',
    userName: 'Sohan',
    oldValues: { username: 'kiran', role: 'USER' },
    newValues: { username: 'kiran', role: 'ADMIN' },
    createdAt: minsAgo(1),
    ...over,
  });

  /**
   * The regression that reached production. The audit row for a login carries
   * the WHOLE user record, role included - so a rule that asked "is the role
   * privileged" rather than "did the role change" raised an alert every time
   * an owner signed in. It was firing on lastLoginAt within hours.
   */
  it('says nothing when only lastLoginAt changed', () => {
    const login = audit({
      oldValues: { username: 'sohan', role: 'DEVELOPER', lastLoginAt: '2026-11-27T10:00:00Z' },
      newValues: { username: 'sohan', role: 'DEVELOPER', lastLoginAt: '2026-11-27T16:04:38Z' },
    });
    expect(privilegeChanges(signals({ recentAudit: [login] }))).toEqual([]);
  });

  it('fires when someone actually becomes ADMIN', () => {
    const [a] = privilegeChanges(signals({ recentAudit: [audit()] }));
    expect(a.rule).toBe('user.privileged_change');
    expect(a.title).toBe('kiran changed from USER to ADMIN');
  });

  it('fires on a demotion out of a privileged role too', () => {
    // Someone losing ADMIN unexpectedly is as worth seeing as someone gaining it.
    const a = audit({
      oldValues: { username: 'kiran', role: 'ADMIN' },
      newValues: { username: 'kiran', role: 'USER' },
    });
    expect(privilegeChanges(signals({ recentAudit: [a] }))[0]?.title).toContain('ADMIN to USER');
  });

  it('calls out a newly created privileged account differently', () => {
    const [a] = privilegeChanges(signals({ recentAudit: [audit({ action: 'user.create' })] }));
    expect(a.title).toMatch(/^New ADMIN account/);
  });

  it('says nothing about an ordinary USER being edited', () => {
    const a = audit({
      oldValues: { username: 'kiran', role: 'USER' },
      newValues: { username: 'kiran', role: 'USER', name: 'Kiran R' },
    });
    expect(privilegeChanges(signals({ recentAudit: [a] }))).toEqual([]);
  });

  it('ignores audit rows that are not about users', () => {
    const a = audit({ action: 'payment.update' });
    expect(privilegeChanges(signals({ recentAudit: [a] }))).toEqual([]);
  });
});

describe('large exports', () => {
  const read = (rows: number) => ({
    action: 'data.bulk_read',
    entityLabel: null,
    userName: 'Sohan',
    oldValues: null,
    newValues: { path: '/ledger/entries', rows },
    createdAt: minsAgo(1),
  });

  it('ignores the ordinary pages that trip the recording threshold', () => {
    // /inventory/black-seed returns ~542 and /payments ~675. Those filled 19%
    // of the audit trail; they must not now fill the alert page too.
    expect(largeExports(signals({ recentAudit: [read(542), read(675)] }), T)).toEqual([]);
  });

  it('fires for a genuine register dump', () => {
    const [a] = largeExports(signals({ recentAudit: [read(1781)] }), T);
    expect(a.rule).toBe('data.large_export');
    expect(a.title).toContain('1781');
  });
});

describe('the state rules', () => {
  it('is silent while the chain verifies', () => {
    expect(chainIntegrity(signals())).toEqual([]);
  });

  it('is CRITICAL when the chain does not', () => {
    const [a] = chainIntegrity(signals({ chain: { ok: false, checked: 1613, failures: 8 } }));
    expect(a.severity).toBe('CRITICAL');
    expect(a.detail?.whatToDo).toContain('RUNBOOK');
  });

  it('is silent while backups are recent', () => {
    expect(backupFreshness(signals(), T, NOW)).toEqual([]);
  });

  it('tolerates one missed night but not two', () => {
    // A PC asleep for a night is not an incident; a backup that has stopped is.
    const oneNight = new Date(NOW.getTime() - 26 * 3600_000);
    const twoNights = new Date(NOW.getTime() - 50 * 3600_000);
    expect(backupFreshness(signals({ lastBackupAt: oneNight }), T, NOW)).toEqual([]);
    expect(backupFreshness(signals({ lastBackupAt: twoNights }), T, NOW)[0]?.severity).toBe('CRITICAL');
  });

  it('is CRITICAL when there is no backup at all', () => {
    const [a] = backupFreshness(signals({ lastBackupAt: null }), T, NOW);
    expect(a.rule).toBe('backup.missing');
    expect(a.severity).toBe('CRITICAL');
  });
});

describe('the whole set', () => {
  it('is silent on a healthy system', () => {
    // The most important test here. A monitoring system that cries wolf on a
    // quiet day is one that gets ignored on a loud one.
    expect(evaluateAll(signals(), T, NOW)).toEqual([]);
  });

  it('reports everything that is wrong at once, not just the first', () => {
    const out = evaluateAll(
      signals({
        recentLogins: Array.from({ length: T.failedLoginsPerUser }, () => login()),
        chain: { ok: false, checked: 10, failures: 2 },
        lastBackupAt: null,
      }),
      T,
      NOW
    );
    const rules = out.map((a) => a.rule);
    expect(rules).toContain('login.failed_burst_user');
    expect(rules).toContain('audit.chain_broken');
    expect(rules).toContain('backup.missing');
  });
});

describe('thresholds', () => {
  it('fall back to the defaults when the environment says nothing', () => {
    expect(thresholdsFromEnv({})).toEqual(DEFAULT_THRESHOLDS);
  });

  it('are overridable, and ignore nonsense', () => {
    const t = thresholdsFromEnv({ ALERT_FAILED_LOGINS_USER: '3', ALERT_LARGE_EXPORT_ROWS: 'lots' });
    expect(t.failedLoginsPerUser).toBe(3);
    expect(t.largeExportRows).toBe(DEFAULT_THRESHOLDS.largeExportRows);
  });
});
