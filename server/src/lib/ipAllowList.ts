import type { Role } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';

/**
 * Optional per-role IP allow-list, per plan item 1.7.
 *
 * Inert by default and inert by construction: a role with no rules is
 * unrestricted. That is the important property — deploying this cannot lock
 * anyone out, and the feature only starts applying once someone deliberately
 * adds a rule. The intended use is "the bank module only from the office", once
 * Phase 2 gives permissions to attach it to.
 */

/** Parse an IPv4 dotted quad into a 32-bit integer, or null. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

/**
 * Normalise what Express hands us. Behind Render's proxy `req.ip` can arrive
 * as an IPv4-mapped IPv6 address (`::ffff:203.0.113.4`), which must match an
 * IPv4 rule.
 */
export function normaliseIp(ip: string | undefined): string | null {
  if (!ip) return null;
  const trimmed = ip.trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
  if (mapped) return mapped[1];
  return trimmed;
}

/**
 * Does `ip` fall inside `cidr`? Supports a bare address (treated as /32) and
 * IPv4 CIDR. An IPv6 rule is matched literally, which is the honest behaviour
 * rather than pretending to do IPv6 prefix maths.
 */
export function ipMatchesCidr(ip: string, cidr: string): boolean {
  const rule = cidr.trim();
  if (!rule) return false;

  const slash = rule.indexOf('/');
  if (slash === -1) return ip === rule;

  const base = rule.slice(0, slash);
  const bits = Number(rule.slice(slash + 1));

  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) {
    // Not IPv4 on one side or the other: only an exact match counts.
    return ip === base;
  }
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  // Shifting by 32 is a no-op in JS, so /32 is handled by the guard above.
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/**
 * Is this address allowed to sign in as this role?
 *
 * Fails **open** on a database error. That is the deliberate choice: this
 * feature is off for everyone by default, so an outage here should restore the
 * default rather than lock the whole company out of their ERP. The lock, the
 * password and MFA are the controls that must fail closed, and they do.
 */
export async function isIpAllowedForRole(
  role: Role,
  ip: string | undefined
): Promise<boolean> {
  try {
    const rules = await prisma.ipAllowRule.findMany({ where: { role }, select: { cidr: true } });
    if (rules.length === 0) return true;

    const normalised = normaliseIp(ip);
    if (!normalised) {
      // Rules exist but we cannot tell where the request came from. Refuse:
      // once someone has opted into an allow-list, "unknown" is not "allowed".
      logger.warn(`IP allow-list: refusing ${role} login with no resolvable client IP`);
      return false;
    }
    return rules.some((r) => ipMatchesCidr(normalised, r.cidr));
  } catch (err) {
    logger.error('IP allow-list check failed; allowing', err);
    return true;
  }
}
