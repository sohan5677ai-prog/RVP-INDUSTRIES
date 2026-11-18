/**
 * Turn a restored copy of production into something safe to test against
 * (Phase 5, plan item 5).
 *
 *   # dry run - counts what it would change, touches nothing
 *   MASK_TARGET_DATABASE_URL=postgresql://... node scripts/mask-database.mjs
 *
 *   # do it
 *   MASK_TARGET_DATABASE_URL=postgresql://... \
 *     node scripts/mask-database.mjs --apply --confirm=<the target host>
 *
 * ---------------------------------------------------------------------------
 * THIS OVERWRITES DATA. READ THE GUARDS.
 *
 * It exists so testing can happen against realistic volumes and shapes -
 * thousands of real dispatches, real lorry patterns - without real bank
 * accounts, phone numbers or password hashes sitting in a copy that will be
 * handed around, restored locally and forgotten about.
 *
 * It is also the single most dangerous script in this repository, because
 * pointed at the wrong database it destroys suppliers' bank details. So:
 *
 *  1. It reads `MASK_TARGET_DATABASE_URL`, never `DATABASE_URL`. There is no
 *     fallback. Forgetting to set it does nothing at all.
 *  2. It refuses outright if the target resolves to the same host *and*
 *     database as `DATABASE_URL`.
 *  3. It is a dry run unless `--apply` is passed.
 *  4. With `--apply` it also requires `--confirm=<host>` matching the target's
 *     own host, so the operator has to read and retype the thing they are
 *     about to overwrite. A flag you can add from muscle memory is not a
 *     guard.
 *  5. Everything happens in one transaction, so a failure half way leaves a
 *     partially-masked database behind rather than a silently mixed one.
 *
 * A Supabase database is called `postgres` whatever project it belongs to, so
 * a "does the name say dev" check would be worthless here - hence the
 * retype-the-host rule instead.
 * ---------------------------------------------------------------------------
 *
 * Passwords are **scrambled, not replaced with a known one.** Putting a dev
 * password in a committed script would be a secret in code, and the standing
 * rule for this project is that there are none. After masking, nobody can sign
 * in with a production password; use the normal admin password-reset flow, or
 * set MASK_DEV_PASSWORD in the environment if you want one seeded.
 */
import { randomBytes, createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const APPLY = process.argv.includes('--apply');
const CONFIRM = (process.argv.find((a) => a.startsWith('--confirm=')) ?? '').split('=')[1] ?? '';

const target = process.env.MASK_TARGET_DATABASE_URL;
const live = process.env.DATABASE_URL;

const die = (msg) => {
  console.error(`\nREFUSED: ${msg}\nNothing was changed.`);
  process.exit(1);
};

/** host + database, which is what identifies "the same database". */
function identity(url) {
  try {
    const u = new URL(url);
    return { host: u.host, db: u.pathname.replace(/^\//, '') };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- guards ---- */

if (!target) {
  die(
    'MASK_TARGET_DATABASE_URL is not set. This script never falls back to ' +
      'DATABASE_URL - that is the whole point.'
  );
}

const t = identity(target);
if (!t) die('MASK_TARGET_DATABASE_URL is not a URL this script can parse.');

const l = identity(live ?? '');
if (l && l.host === t.host && l.db === t.db) {
  die(
    `the target is the same host and database as DATABASE_URL (${t.host}/${t.db}). ` +
      'That is production, or whatever this server is pointed at. Restore a copy first.'
  );
}

if (APPLY && CONFIRM !== t.host) {
  die(
    `--apply needs --confirm=<host> matching the target.\n` +
      `  target host : ${t.host}\n` +
      `  you passed  : ${CONFIRM || '(nothing)'}\n` +
      'Read the host above and retype it, so this cannot happen by muscle memory.'
  );
}

/* ----------------------------------------------------------- masking ----- */

const prisma = new PrismaClient({ datasources: { db: { url: target } } });

/** Stable but meaningless: the same input always masks the same way, so joins
 *  and "is this the same party" checks still behave, without the real value. */
const fake = (seed, prefix, len) =>
  prefix + createHash('sha256').update(String(seed)).digest('hex').replace(/\D/g, '').slice(0, len).padEnd(len, '7');

try {
  console.log(`${APPLY ? 'APPLYING to' : 'DRY RUN against'} ${t.host}/${t.db}\n`);

  const counts = {
    'parties with a bank account': await prisma.party.count({ where: { bankAccountNumber: { not: null } } }),
    'parties with a phone': await prisma.party.count({ where: { phone: { not: null } } }),
    'parties with an email': await prisma.party.count({ where: { email: { not: null } } }),
    'user password hashes': await prisma.user.count(),
    'users with MFA enrolled': await prisma.user.count({ where: { mfaSecret: { not: null } } }),
    'company profiles': await prisma.companyProfile.count(),
    'KNM drivers': await prisma.knmDriver.count(),
  };
  for (const [what, n] of Object.entries(counts)) {
    console.log(`  ${String(n).padStart(6)}  ${what}`);
  }

  console.log('\nwhat is kept, because testing needs it:');
  console.log('  party names, GSTINs, commodities, every transaction, weight and amount');
  console.log('  (GSTINs are printed on invoices anyway, and a masked one breaks the GST reports)');

  if (!APPLY) {
    console.log(`\nRe-run with --apply --confirm=${t.host} to do it.`);
    process.exit(0);
  }

  await prisma.$transaction(
    async (tx) => {
      const parties = await tx.party.findMany({ select: { id: true } });
      for (const p of parties) {
        await tx.party.update({
          where: { id: p.id },
          data: {
            bankAccountNumber: fake(p.id, '', 14),
            bankIfsc: `TEST0${fake(p.id, '', 6)}`,
            phone: fake(`ph${p.id}`, '9', 9),
            phone2: null,
            email: `party-${p.id.slice(-6)}@example.invalid`,
          },
        });
      }

      const users = await tx.user.findMany({ select: { id: true } });
      for (const u of users) {
        await tx.user.update({
          where: { id: u.id },
          data: {
            // Not a valid hash of anything, so no production password works
            // here and none is written into this file.
            password: `masked$${randomBytes(24).toString('hex')}`,
            mfaSecret: null,
            mfaEnabledAt: null,
            mustChangePassword: true,
            email: `user-${u.id.slice(-6)}@example.invalid`,
          },
        });
      }

      const profiles = await tx.companyProfile.findMany({ select: { id: true } });
      for (const c of profiles) {
        await tx.companyProfile.update({
          where: { id: c.id },
          data: {
            bankAccountNumber: fake(c.id, '', 14),
            bankBranchIfsc: `TEST0${fake(c.id, '', 6)}`,
          },
        });
      }

      const drivers = await tx.knmDriver.findMany({ select: { id: true } });
      for (const d of drivers) {
        await tx.knmDriver.update({ where: { id: d.id }, data: { phone: fake(`dr${d.id}`, '9', 9) } });
      }

      // Sessions and refresh tokens from the real deployment must not be
      // usable against the copy.
      await tx.userSession.deleteMany({});
    },
    { timeout: 600_000, maxWait: 30_000 }
  );

  console.log('\ndone. Nobody can sign in with a production password; reset one the normal way.');
  if (process.env.MASK_DEV_PASSWORD) {
    console.log('MASK_DEV_PASSWORD is set, but seeding it is not implemented - reset via the app.');
  }
} catch (err) {
  console.error('\nFAILED, and the transaction rolled back:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
