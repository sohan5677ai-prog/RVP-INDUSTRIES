/**
 * Every authenticated route must have a permission rule.
 *
 * This is the test that makes Phase 2 hold. The Phase 0 audit missed the
 * anonymous scale endpoints by reading route files and trusting the gaps to
 * stand out; with 415 routes that does not work. So the route table is
 * enumerated mechanically by scripts/audit-routes.mjs and cross-checked
 * against lib/routePermissions.ts here — a route added without a rule fails
 * CI rather than quietly inheriting whatever its neighbours happen to have.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolveRoutePermission, ROUTE_RULES } from '../src/lib/routePermissions.js';
import { PERMISSION_SET } from '../src/lib/permissions.js';

interface AuditRow {
  method: string;
  full: string;
  level: string;
  file: string;
  line: number;
}

/** Ask the audit script for the live route table. */
function routeTable(): AuditRow[] {
  const out = execFileSync('node', ['scripts/audit-routes.mjs', '--json'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(out) as AuditRow[];
}

/**
 * Routes that are reachable without authentication and so are outside the
 * permission model. Every one was verified by hand during Phases 6a, 6b and 1;
 * listing them here means a NEW public route fails this test rather than
 * joining the list unnoticed.
 */
const KNOWN_PUBLIC = new Set([
  'POST /api/auth/login',
  'POST /api/auth/mfa/verify',
  'POST /api/auth/refresh',
  'POST /api/auth/kiosk',
  'POST /api/auth/forgot-password',
  'POST /api/auth/reset-password',
  'GET /api/health',
  'GET /api/health/db',
  'GET /api/system/maintenance/status',
  'POST /api/subscription/webhook',
  'POST /api/webhooks/resend',
  'GET /api/webhooks/whatsapp',
  'POST /api/webhooks/whatsapp',
  'POST /api/webhooks/whatsapp/jobs/:job',
  'POST /api/weighbridge/cctv/broadcast',
  'GET /api/weighbridge/tickets/:id/slip.pdf',
  'GET /api/weighbridge/tickets/:id/slip.jpg',
]);

const table = routeTable();

describe('the route table itself', () => {
  it('is non-trivial, so a broken audit script cannot make this suite pass', () => {
    expect(table.length).toBeGreaterThan(350);
  });

  it('exposes nothing publicly that is not on the reviewed list', () => {
    const unexpected = table
      .filter((r) => r.level === 'PUBLIC' || r.level === 'unknown')
      .map((r) => `${r.method} ${r.full}`)
      .filter((key) => !KNOWN_PUBLIC.has(key));
    expect(unexpected).toEqual([]);
  });
});

describe('permission coverage', () => {
  const authed = table.filter((r) => r.level !== 'PUBLIC' && r.level !== 'unknown');

  it('covers every authenticated route', () => {
    const uncovered = authed
      .filter((r) => {
        const path = r.full.replace(/^\/api/, '') || '/';
        return !resolveRoutePermission(r.method, path).matched;
      })
      .map((r) => `${r.method} ${r.full}   (${r.file}:${r.line})`);

    // Printed in full on failure: the point is to say exactly which route
    // needs a rule, not merely that one does.
    expect(uncovered, `routes with no permission rule:\n${uncovered.join('\n')}`).toEqual([]);
  });

  it('names only permissions that exist', () => {
    const bogus = ROUTE_RULES.filter(
      (r) => r.permission !== null && !PERMISSION_SET.has(r.permission)
    ).map((r) => `${r.path} -> ${r.permission}`);
    expect(bogus).toEqual([]);
  });

  it('leaves very few routes open to any authenticated user', () => {
    const open = authed.filter((r) => {
      const path = r.full.replace(/^\/api/, '') || '/';
      const res = resolveRoutePermission(r.method, path);
      return res.matched && res.permission === null;
    });
    // Only the caller's own account should be in here. A number creeping up
    // means someone widened `permission: null` to dodge a mapping.
    expect(open.every((r) => r.full.startsWith('/api/auth/'))).toBe(true);
  });
});

describe('resolution rules', () => {
  it('matches a collection and its items from one trailing-star pattern', () => {
    expect(resolveRoutePermission('GET', '/brokers').permission).toBe('master.broker.view');
    expect(resolveRoutePermission('GET', '/brokers/abc123').permission).toBe('master.broker.view');
  });

  it('separates delete from the other writes', () => {
    expect(resolveRoutePermission('POST', '/payments').permission).toBe('payment.manage');
    expect(resolveRoutePermission('PATCH', '/payments/abc').permission).toBe('payment.manage');
    // The irreversible one needs its own permission - before Phase 2 any
    // signed-in user could do this.
    expect(resolveRoutePermission('DELETE', '/payments/abc').permission).toBe('payment.delete');
  });

  it('prefers a specific rule over the general one it sits under', () => {
    expect(resolveRoutePermission('POST', '/sale-dispatches/abc/invoice').permission).toBe(
      'sale.invoice.issue'
    );
    expect(resolveRoutePermission('POST', '/sale-dispatches/abc/mark-delivered').permission).toBe(
      'sale.dispatch.manage'
    );
  });

  it('does not let a :param swallow extra segments', () => {
    // `/parties/:id` must not match `/parties/a/b`, or a nested route could
    // inherit the wrong permission.
    const re = resolveRoutePermission('DELETE', '/parties/abc');
    expect(re.permission).toBe('master.party.delete');
  });

  it('reports no match rather than guessing', () => {
    const res = resolveRoutePermission('GET', '/something-that-does-not-exist');
    expect(res.matched).toBe(false);
    expect(res.permission).toBeNull();
  });
});
