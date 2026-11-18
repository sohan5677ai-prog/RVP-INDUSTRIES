import { PrismaClient } from '@prisma/client';
import { createAuditExtension, type AuditHooks } from './auditExtension.js';

/**
 * Connection-pool defaults applied to DATABASE_URL when it doesn't set them.
 *
 * Prisma's default pool size is `num_cpus * 2 + 1`, and inside a container it
 * reads the HOST's core count rather than our share - so a single small Render
 * instance can try to hold ~17 connections against Supabase's pooler. Once the
 * pooler's allowance is used up, further queries queue against `pool_timeout`
 * (10s by default) and the UI just spins before failing, which is exactly the
 * "loading for a long time" symptom.
 *
 * 5 is comfortably under the free-tier pooler allowance while still serving our
 * concurrency (the heavy dues/ledger pages fetch `?all=true`, so a few open tabs
 * can ask for several connections at once). The longer 20s pool_timeout means a
 * brief burst waits its turn instead of erroring outright.
 *
 * Set either parameter explicitly in DATABASE_URL to override - anything already
 * present in the URL is left exactly as written.
 */
const POOL_DEFAULTS: Record<string, string> = {
  connection_limit: '5',
  pool_timeout: '20',
};

/**
 * Append the missing pool parameters to a connection string.
 *
 * Deliberately textual rather than a `new URL()` round-trip: parsing and
 * re-serialising would re-encode the credentials in the userinfo section, and a
 * password containing a character the URL serialiser normalises differently
 * would silently break every connection in production. Appending to the query
 * string never touches the credentials.
 */
function withPoolDefaults(raw: string): string {
  let out = raw;
  for (const [key, value] of Object.entries(POOL_DEFAULTS)) {
    if (new RegExp(`[?&]${key}=`).test(out)) continue;
    out += `${out.includes('?') ? '&' : '?'}${key}=${value}`;
  }
  return out;
}

// DIRECT_URL is left alone - it is only used by the Prisma CLI for schema work,
// where a single short-lived connection is the point.
const databaseUrl = process.env.DATABASE_URL ? withPoolDefaults(process.env.DATABASE_URL) : undefined;

// Reuse a single PrismaClient across hot-reloads in dev to avoid
// exhausting the connection pool.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const base =
  globalForPrisma.prisma ?? new PrismaClient(databaseUrl ? { datasourceUrl: databaseUrl } : undefined);

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = base;
}

/**
 * Audit hooks, injected rather than imported.
 *
 * The extension needs the audit service, and the audit service needs this
 * client - importing one from the other would be a cycle. So the hooks are
 * registered at boot (services/audit.service.ts) and the extension is an inert
 * passthrough until then. That also means a script or test that imports this
 * module gets a plain client and writes no audit rows, which is the right
 * default for a one-off maintenance script.
 */
let auditHooks: AuditHooks | null = null;

export function registerAuditHooks(hooks: AuditHooks): void {
  auditHooks = hooks;
}

export function auditingEnabled(): boolean {
  return auditHooks !== null;
}

export const prisma = base.$extends(
  createAuditExtension({
    readBefore: async (model, id) => {
      if (!auditHooks) return undefined;
      return auditHooks.readBefore(model, id);
    },
    record: async (event) => {
      if (!auditHooks) return;
      await auditHooks.record(event);
    },
    onError: (message, err) => auditHooks?.onError(message, err),
  })
) as unknown as PrismaClient;
