/**
 * A passive security check of a running instance (Phase 10, plan item 2).
 *
 *   node scripts/passive-scan.mjs http://localhost:4100 http://localhost:5174
 *
 * ---------------------------------------------------------------------------
 * What this is, and what it is NOT
 *
 * The plan asks for an OWASP ZAP baseline scan. A ZAP baseline is **passive**:
 * it spiders the app and applies rules about response headers, cookie flags
 * and information disclosure. It does not attack anything - that is the
 * active scan, which belongs in the VAPT engagement proper.
 *
 * This implements the header, cookie and disclosure checks a baseline reports,
 * so they can be run on any machine without Docker. It is **not** ZAP: it does
 * not spider, so it only sees the URLs it is given, and it has no rule
 * database behind it.
 *
 * Run the real ZAP baseline as well when Docker is available:
 *   docker run --rm -t ghcr.io/zaproxy/zaproxy:stable zap-baseline.py \
 *     -t http://host.docker.internal:5174
 * ---------------------------------------------------------------------------
 */

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: node scripts/passive-scan.mjs <url> [url...]');
  process.exit(2);
}

const findings = [];
const note = (level, target, rule, detail) => findings.push({ level, target, rule, detail });

/** Headers a baseline scan expects, and what their absence means. */
const EXPECTED = [
  {
    header: 'content-security-policy',
    level: 'MEDIUM',
    why: 'No CSP: a reflected or stored script has nothing stopping it.',
    // A report-only policy is a deliberate stage, not an absence.
    alt: 'content-security-policy-report-only',
  },
  {
    header: 'x-content-type-options',
    level: 'LOW',
    why: 'Without nosniff a browser may guess a response is script.',
  },
  {
    header: 'x-frame-options',
    level: 'MEDIUM',
    why: 'No clickjacking protection, unless CSP frame-ancestors covers it.',
    alt: 'content-security-policy',
  },
  {
    header: 'strict-transport-security',
    level: 'MEDIUM',
    why: 'No HSTS: a first request can be downgraded to HTTP.',
    httpsOnly: true,
  },
  {
    header: 'referrer-policy',
    level: 'LOW',
    why: 'URLs may leak to third parties in the Referer header.',
  },
];

/** Headers that give away more than they need to. */
const DISCLOSURE = ['server', 'x-powered-by', 'x-aspnet-version'];

async function check(url) {
  let res;
  try {
    res = await fetch(url, { redirect: 'manual' });
  } catch (err) {
    note('ERROR', url, 'unreachable', String(err?.message ?? err));
    return;
  }

  // Follow a redirect before judging headers. The first version of this did
  // not, so it reported the 308 from the apex domain to www as "no CSP, no
  // X-Frame-Options" while the actual page sent both - a false finding that
  // would have sent somebody chasing a problem that was not there. A redirect
  // carries almost no headers by design; the page behind it is the subject.
  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get('location');
    if (to) {
      const dest = new URL(to, url).toString();
      note('INFO', url, `redirects to ${dest}`, 'headers judged at the destination');
      try {
        res = await fetch(dest, { redirect: 'follow' });
        url = dest;
      } catch (err) {
        note('ERROR', dest, 'redirect target unreachable', String(err?.message ?? err));
        return;
      }
    }
  }

  const h = Object.fromEntries([...res.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
  const isHttps = url.startsWith('https://');

  for (const e of EXPECTED) {
    if (e.httpsOnly && !isHttps) continue;
    if (h[e.header]) continue;
    if (e.alt && h[e.alt]) {
      note('INFO', url, `${e.header} absent`, `covered by ${e.alt}`);
      continue;
    }
    note(e.level, url, `missing ${e.header}`, e.why);
  }

  for (const d of DISCLOSURE) {
    if (h[d]) note('LOW', url, `${d} header present`, `reveals "${h[d]}"`);
  }

  // Cookie flags. A session cookie without HttpOnly is readable by script;
  // without Secure it crosses plain HTTP.
  const cookies = res.headers.getSetCookie?.() ?? [];
  for (const c of cookies) {
    const name = c.split('=')[0];
    if (!/httponly/i.test(c)) note('MEDIUM', url, `cookie ${name} not HttpOnly`, c.slice(0, 60));
    if (isHttps && !/secure/i.test(c)) note('MEDIUM', url, `cookie ${name} not Secure`, c.slice(0, 60));
    if (!/samesite/i.test(c)) note('LOW', url, `cookie ${name} has no SameSite`, c.slice(0, 60));
  }

  // A body that names the stack, or a stack trace, is information disclosure.
  const body = await res.text().catch(() => '');
  if (/at\s+\w+\s+\(.*[/\\].*:\d+:\d+\)/.test(body)) {
    note('HIGH', url, 'stack trace in response', body.slice(0, 120));
  }

  console.log(`  checked ${url} -> ${res.status}`);
}

console.log('passive check (not ZAP - see the header of this file)\n');
for (const t of targets) await check(t);

// Error paths matter as much as the happy one: a 404 and a 500 are where
// frameworks leak their identity.
for (const t of targets) {
  await check(`${t.replace(/\/$/, '')}/this-path-does-not-exist-${Date.now()}`);
}

const order = { HIGH: 0, MEDIUM: 1, LOW: 2, INFO: 3, ERROR: 0 };
findings.sort((a, b) => order[a.level] - order[b.level]);

console.log(`\n${findings.length} finding(s)\n`);
for (const f of findings) {
  console.log(`  ${f.level.padEnd(7)} ${f.rule}`);
  console.log(`          ${f.target}`);
  console.log(`          ${f.detail}`);
}

const serious = findings.filter((f) => f.level === 'HIGH' || f.level === 'ERROR');
if (serious.length > 0) {
  console.log(`\n${serious.length} finding(s) at HIGH or above.`);
  process.exit(1);
}
console.log('\nNothing at HIGH.');
