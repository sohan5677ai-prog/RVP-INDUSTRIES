/**
 * Look for secrets that have got into the repository (Phase 9 item 4,
 * Phase 6 item 10).
 *
 *   node scripts/scan-secrets.mjs          # scan tracked files, exit 1 on a hit
 *   node scripts/scan-secrets.mjs --staged # only what is about to be committed
 *
 * Run from the repository root or from server/.
 *
 * ---------------------------------------------------------------------------
 * A scanner that cries wolf is a scanner that gets bypassed with --no-verify,
 * so this is deliberately narrow. It looks for shapes that are only ever real
 * credentials - a JWT, a PEM private key, an AWS access key id, a Supabase
 * publishable or service key - plus assignments to names like SECRET or
 * PASSWORD whose value is not obviously a placeholder.
 *
 * It does NOT flag every long hex string. Hashes, cuids, commit ids and test
 * fixtures are full of them, and flagging those teaches people to ignore it.
 * The 64-hex case is reported only inside an assignment to a key-ish name.
 * ---------------------------------------------------------------------------
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const STAGED = process.argv.includes('--staged');

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

/** Paths where a credential-shaped string is expected and harmless. */
const ALLOW_PATHS = [
  /(^|\/)\.env\.example$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)docs\/security\//,
  // Tests deliberately contain fake credentials to prove they are redacted.
  /\.test\.ts$/,
  /(^|\/)tests?\//,
];

/**
 * Values that are plainly not real.
 *
 * The second pattern matters as much as the first: a value that *declares
 * itself* a test value - `test-only-secret-not-used-in-production` in
 * vitest.config.ts - is not a leak, and flagging it would be the first step
 * towards this scanner being run with --no-verify.
 */
const PLACEHOLDER = /^(|x+|\.\.\.|<[^>]*>|your[-_ ]?\w*|change[-_ ]?me|placeholder|example|test|dummy|fake|secret|password|todo|none|null|undefined|\$\{[^}]*\}|process\.env\.\w+)$/i;
const SELF_DECLARED_FAKE = /(^|[-_])(test|dev|local|sample|example|fake|dummy)[-_]only|not[-_]?(used[-_]?in[-_]?)?prod|do[-_]?not[-_]?use/i;

const RULES = [
  {
    name: 'PEM private key',
    re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    name: 'JWT / Supabase key',
    // Three base64url segments starting with a JSON header.
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'Slack token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/g },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    name: 'credential assignment',
    // KEY = "value" where the name looks secret and the value does not look
    // like a placeholder. Captures the value so it can be judged.
    re: /\b([A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?TOKEN|PRIVATE_?KEY|SERVICE_ROLE)[A-Z0-9_]*)\s*[:=]\s*["'`]([^"'`\n]{8,})["'`]/g,
    judge: (m) =>
      !PLACEHOLDER.test(m[2].trim()) &&
      !SELF_DECLARED_FAKE.test(m[2]) &&
      !/^process\.env\./.test(m[2]),
  },
];

function trackedFiles() {
  const args = STAGED
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACM']
    : ['ls-files'];
  return execFileSync('git', args, { encoding: 'utf8', cwd: repoRoot })
    .split('\n')
    .filter(Boolean);
}

const findings = [];
let scanned = 0;

for (const rel of trackedFiles()) {
  if (ALLOW_PATHS.some((re) => re.test(rel))) continue;
  const full = path.join(repoRoot, rel);

  let text;
  try {
    if (statSync(full).size > 2 * 1024 * 1024) continue;
    text = readFileSync(full, 'utf8');
  } catch {
    continue; // deleted, binary, or unreadable
  }
  if (text.includes('\u0000')) continue;
  scanned++;

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      if (rule.judge && !rule.judge(m)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      const shown = (m[2] ?? m[0]).slice(0, 12);
      findings.push(`${rel}:${line}  ${rule.name}  ${shown}...`);
    }
  }
}

console.log(`scanned ${scanned} tracked file(s)${STAGED ? ' (staged only)' : ''}`);

if (findings.length === 0) {
  console.log('no secrets found.');
  process.exit(0);
}

console.error(`\n${findings.length} possible secret(s):\n`);
for (const f of findings.slice(0, 50)) console.error(`  ${f}`);
if (findings.length > 50) console.error(`  ...and ${findings.length - 50} more`);
console.error(
  '\nIf one is real: rotate it first, then remove it. Deleting it from the working tree\n' +
    'is not enough - it stays in the history, so treat it as disclosed and rotate.'
);
process.exit(1);
