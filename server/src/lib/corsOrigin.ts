/**
 * Which browser origins may call this API.
 *
 * Split out of index.ts so the decision is unit-testable, because getting it
 * wrong is expensive in both directions: too tight and the deployed client
 * cannot reach the API at all, too loose and any site on the internet can.
 *
 * The previous rule accepted `origin.includes('localhost')` and
 * `origin.endsWith('.vercel.app')`, which between them let through
 * `https://rvp-localhost.attacker.com` and every Vercel deployment in
 * existence. This module matches whole origins instead of substrings.
 *
 * In production the client calls the Render API on its absolute URL rather
 * than through the Vercel rewrite, so this list is load-bearing: the
 * production origin is baked in as a default (see PRODUCTION_ORIGINS) so that
 * an unset CLIENT_ORIGIN cannot take the app down, and CLIENT_ORIGIN adds to
 * it for custom domains and preview deployments.
 */

/**
 * Origins that are always allowed, regardless of configuration — the deployed
 * client. Add a custom domain here or, better, to CLIENT_ORIGIN.
 */
export const PRODUCTION_ORIGINS = ['https://rvp-industries.vercel.app'];

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface OriginPolicy {
  /** Exact origins to accept, e.g. "https://app.example.com". */
  allowed: string[];
  /** Accept http(s)://localhost:* and 127.0.0.1:* — development only. */
  allowLocalhost: boolean;
}

/** Normalise an origin for comparison: lowercase, no trailing slash. */
function normalise(origin: string): string {
  return origin.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Parse the comma-separated CLIENT_ORIGIN env var and union it with the
 * built-in production origins. Blank entries are dropped so a trailing comma
 * or a stray space can never widen the list to "".
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  const configured = (raw ?? '')
    .split(',')
    .map(normalise)
    .filter(Boolean);
  return [...new Set([...PRODUCTION_ORIGINS.map(normalise), ...configured])];
}

/**
 * Build the policy from the environment. Localhost is accepted only outside
 * production, so a deployed server never trusts an origin it cannot verify.
 */
export function originPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): OriginPolicy {
  return {
    allowed: parseAllowedOrigins(env.CLIENT_ORIGIN),
    allowLocalhost: env.NODE_ENV !== 'production',
  };
}

/**
 * Whole-origin match. An unparseable Origin header is rejected rather than
 * string-compared, so nothing gets in on a malformed value.
 */
export function isOriginAllowed(origin: string, policy: OriginPolicy): boolean {
  const candidate = normalise(origin);
  if (!candidate) return false;
  if (policy.allowed.includes(candidate)) return true;

  if (!policy.allowLocalhost) return false;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // url.hostname strips the brackets from an IPv6 literal; check both forms.
  return LOCAL_HOSTNAMES.has(url.hostname);
}
