/**
 * Keep sensitive values out of the logs (Phase 5, plan item 6).
 *
 * Render keeps stdout, and anyone who can read the service's logs can read
 * whatever we printed into them. Today that includes real request bodies -
 * `logger.warn('...', req.body)` in the weighbridge controller, and a
 * `JSON.stringify(req.body)` baked straight into a message string in the
 * WhatsApp controller - so a supplier's bank account reaches the log the first
 * time a payment request fails validation.
 *
 * ---------------------------------------------------------------------------
 * Two mechanisms, and only the first is reliable
 *
 * 1. **By key name**, recursively. This is the mechanism. A field called
 *    `bankAccountNumber` is redacted wherever it appears and whatever it
 *    holds, so a new endpoint logging a whole row is covered without anyone
 *    remembering to think about it.
 *
 * 2. **By pattern, inside strings**. This is a backstop, not a guarantee, and
 *    it is worth being honest about where it stops. A bank account number
 *    pasted into a free-text note is indistinguishable from any other digits.
 *    The digit-run rule deliberately starts at 11 characters so that a
 *    ten-digit Indian mobile survives: phone numbers are in the logs
 *    constantly and are needed to debug a WhatsApp send, and a scrubber that
 *    makes real faults harder to diagnose will be switched off. That means a
 *    nine- or ten-digit account number in free text is not caught by the
 *    pattern - the key-name rule is what covers it when it is a field, which
 *    is the ordinary case.
 * ---------------------------------------------------------------------------
 *
 * This is a separate list from the audit trail's. The audit log deliberately
 * *keeps* `bankAccountNumber`: "this supplier's account changed from X to Y"
 * is the single most important thing it records. Logs have no such need, so
 * they get the stricter list. See services/audit.service.ts.
 */

export const REDACTED = '[redacted]';

/** Depth beyond which we stop walking. Logging must not become the cost. */
const MAX_DEPTH = 8;

/**
 * Keys whose value never belongs in a log, matched case-insensitively against
 * the whole key, plus a few substrings for header-ish names.
 */
const SENSITIVE_KEYS = new Set(
  [
    // credentials
    'password',
    'currentpassword',
    'newpassword',
    'confirmpassword',
    'passwordhash',
    'mfasecret',
    'totpsecret',
    'refreshtoken',
    'refreshtokenhash',
    'accesstoken',
    'token',
    'tokenhash',
    'codehash',
    'otp',
    'code',
    'secret',
    'apikey',
    'apisecret',
    'privatekey',
    'clientsecret',
    'signingsecret',
    'authorization',
    'cookie',
    'setcookie',
    'sessionid',
    'sid',
    // banking and identity
    'bankaccountnumber',
    'bankaccountname',
    'accountnumber',
    'accountno',
    'acno',
    'ifsc',
    'bankifsc',
    'upi',
    'upiid',
    'pan',
    'panno',
    'pannumber',
    'aadhaar',
    'aadhar',
    'aadhaarnumber',
    'cardnumber',
    'cvv',
    // third-party credentials this project actually holds
    'taxprogspsecret',
    'taxprogstpass',
    'bridgekey',
  ].map((k) => k.toLowerCase())
);

/** Substrings that make a key sensitive whatever else it is called. */
const SENSITIVE_PARTS = ['password', 'secret', 'apikey', 'authorization', 'aadhaar', 'bankaccount'];

/**
 * Exported because the winston format has to apply it to the top level of the
 * `info` object itself, where metadata keys land. `scrub` only sees keys of
 * objects it walks into, so without this a `logger.warn('...', { password })`
 * reached the log in the clear - the one thing this module exists to stop.
 */
export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[_-]/g, '');
  if (SENSITIVE_KEYS.has(k)) return true;
  return SENSITIVE_PARTS.some((part) => k.includes(part));
}

/**
 * Patterns worth redacting inside free text.
 *
 * Ordered most specific first, since an earlier replacement removes the
 * characters a later one would have matched.
 */
const TEXT_PATTERNS: { name: string; re: RegExp }[] = [
  // A JWT. Three base64url segments; the header of a JSON JWT always starts eyJ.
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g },
  // Bearer <anything>, and the same for a basic auth header.
  { name: 'bearer', re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  // key=value / "key": "value" for a sensitive name, which is how the
  // JSON.stringify(req.body) calls get it into the message string.
  {
    name: 'inline-pair',
    re: /("?)(password|token|secret|apikey|api_key|mfaSecret|bankAccountNumber|ifsc|pan|aadhaar)\1(\s*[:=]\s*)("?)([^",}\s]+)\4/gi,
  },
  // Argon2 / bcrypt hashes, which look nothing like the above. The character
  // class has to admit commas and `=`, because an argon2 hash carries its own
  // parameters: $argon2id$v=19$m=65536,t=3,p=4$salt$hash. Stopping at `,`
  // left the tail of every hash in the log.
  { name: 'pwdhash', re: /\$(argon2[a-z]*|2[aby])\$[^\s"'}]+/gi },
  // A PAN: five letters, four digits, one letter.
  { name: 'pan', re: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g },
  // A long digit run: Aadhaar is 12, most account numbers 11-18. Starts at 11
  // so a ten-digit mobile is left readable - see the note at the top.
  { name: 'digits', re: /\b\d{11,19}\b/g },
];

/** Redact the patterns above inside one string. */
export function scrubText(text: string): string {
  let out = text;
  for (const { name, re } of TEXT_PATTERNS) {
    out =
      name === 'inline-pair'
        ? out.replace(re, (_m, q1, key, sep, _q2) => `${q1}${key}${q1}${sep}"${REDACTED}"`)
        : out.replace(re, REDACTED);
  }
  return out;
}

/**
 * Return a scrubbed copy of a value.
 *
 * A copy, never a mutation: logging must not alter what the application is
 * holding. Cycles are tolerated because a logged request or Prisma object may
 * well contain one, and a stack overflow inside the logger would take down
 * whatever it was trying to report.
 */
export function scrub(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;

  if (depth >= MAX_DEPTH) return '[depth limit]';
  if (seen.has(value as object)) return '[circular]';

  if (value instanceof Date) return value;
  if (value instanceof Error) {
    // Keep it an Error so winston's own formatting still applies.
    const copy = new Error(scrubText(value.message));
    copy.name = value.name;
    if (value.stack) copy.stack = scrubText(value.stack);
    return copy;
  }
  if (Buffer.isBuffer(value)) return `[buffer ${value.length}b]`;

  seen.add(value as object);
  try {
    if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1, seen));

    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : scrub(v, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value as object);
  }
}
