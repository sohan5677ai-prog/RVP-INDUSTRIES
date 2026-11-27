# Security checklist

Every item of the security plan, what implements it, and what is still open.
Last verified: **27 Nov 2026** · Tests at that point: **84 files, 960 tests**

Legend: **Done** · **Partial** — working, with a stated limit · **Open** · **Blocked**

---

## Phase 0 — Audit

| # | Item | State | Where |
|---|---|---|---|
| | Five HIGH, six MEDIUM, three LOW findings | Done | [PHASE-0.md](PHASE-0.md) |
| H1 | Stack traces returned to clients | Done | `middleware/error.ts` |
| H2 | CORS allowed any origin containing "localhost" | Done | `lib/corsOrigin.ts` + tests |
| H3 | Token in localStorage, no revocation | Done | Phase 1 — `UserSession`, rotating refresh tokens |
| H4 | Flat authorization | Done | Phase 2 — `lib/routePermissions.ts` |
| H5 | No audit trail | Done | Phase 4 — `lib/auditExtension.ts` |

## Phase 1 — Identity and access

| # | Item | State | Where |
|---|---|---|---|
| 1.1 | Password policy, NIST-style | Done | `lib/passwordPolicy.ts` — min 12, blocklist, no character classes |
| 1.2 | argon2id, bcrypt upgraded on login | Done | `lib/password.ts` |
| 1.3 | Lockout and login-attempt record | Done | `LoginAttempt`, `failedLoginCount`, `lockedUntil` |
| 1.4 | TOTP two-factor | Done (code) / **Open** (adoption) | `otpauth`; `MFA_ENFORCE` unset and **0 of 4 privileged accounts enrolled** |
| 1.5 | Session revocation on password or role change | Done | `revokeSessions`, `pwdAt` claim |
| 1.6 | Short access token, rotating refresh token | Done | 15 min / 12 h absolute |
| 1.7 | New-device alert | Done | `sendNewDeviceAlert` |
| 1.8 | Device cap and idle sign-out | Done | 2 devices, 20 min idle |

## Phase 2 — Authorization

| # | Item | State | Where |
|---|---|---|---|
| 2.1 | Permission model, deny by default | Done | `lib/permissions.ts`, `DEFAULT_ROLE_PERMISSIONS` |
| 2.2 | Every route covered | Done | `lib/routePermissions.ts`; `scripts/audit-routes.mjs` enumerates, a test enforces |
| 2.3 | Public routes on a reviewed list | Done | `tests/routePermissionCoverage.test.ts` — a new public route fails the suite until reviewed |
| 2.4 | Ownership checks return 404 not 403 | Done | `lib/ownership.ts` |
| 2.5 | Maker-checker, approval limits | Done | `services/makerChecker.service.ts` — requester cannot approve; limit lookup fails to zero |
| 2.6 | Permission denials recorded | Done | `PermissionDenial` |
| | `RBAC_ENFORCE` | **Partial** | Ships observable-then-enforced; flag unset |

## Phase 3 — Master data protection

| # | Item | State | Where |
|---|---|---|---|
| 3.1 | Protected fields need approval | Done | `lib/masterFields.ts` — includes `email`, where the alert goes |
| 3.2 | Field-level history | Done | `MasterChangeLog` |
| 3.3 | Alert on a bank-detail change | Done | `sendMasterChangeAlert` |

## Phase 4 — Audit trail

| # | Item | State | Where |
|---|---|---|---|
| 4.1/4.2 | Automatic capture, redaction | Done | `lib/auditExtension.ts` — unknown models audited by default |
| 4.3 | Tamper evidence | Done | `lib/auditChain.ts`; `scripts/verify-audit-chain.mjs` exits non-zero |
| | Make `AuditLog` append-only (`REVOKE`) | **Open** | Documented in [PHASE-4.md](PHASE-4.md); blocks 4.6 |
| 4.4 | Cancel, not delete | **Partial** | Payments, receipts, set-offs done. **Purchases, sales, notes, loans still hard-delete** |
| 4.5 | Period lock | Done | `lib/periodLock.ts`, enforced in the one place a journal entry is written; fails closed |
| 4.6 | Retention job | **Blocked** | Needs the `REVOKE` decision — pruning breaks the chain |
| 4.7 | Viewer | Done | `/audit-trail` |

## Phase 5 — Data protection

| # | Item | State | Where |
|---|---|---|---|
| 5.1 | HTTPS, HSTS, TLS 1.2+, redirect | Done | Measured: 1-year HSTS, Render 301, Vercel 308. `preload` **not** taken — a DNS decision |
| 5.2 | Field-level encryption | **Deferred, recorded** | No Aadhaar or PAN column exists; reduces to one field. Reasoning in [PHASE-5.md](PHASE-5.md) |
| 5.3 | Masking, `pii.view`, audited reveals | Done | `lib/pii.ts`; `GET /parties/:id/bank` records who looked |
| 5.4 | Export controls | **Partial** | No server-side exports exist, so `report.export` has nothing to gate. Large reads are recorded instead |
| 5.5 | Masked copy for testing | Done (script) / **Open** (never run) | `scripts/mask-database.mjs`, four refusals exercised |
| 5.6 | Log scrubber | Done | `lib/logScrubber.ts` — by key name, with pattern as a stated backstop |
| | Public invoice bucket (6B M2) | Done | Bucket private; `GET /api/files/:name` with an expiring signed token |

## Phase 6 — Application hardening

| # | Item | State | Where |
|---|---|---|---|
| 6.1 | No raw SQL concatenation | Done | Prisma throughout; raw queries are parameterised |
| 6.2 | Output encoding, CSP | **Partial** | CSP present on both; **still Report-Only on the client** |
| 6.3 | CSRF | N/A | Bearer tokens, not cookie auth |
| 6.4 | Server-side validation everywhere | Done | `zod` on every input |
| 6.5 | Security headers | Done | Verified 27 Nov — see "Passive scan" below |
| 6.6 | Upload allow-list, magic bytes, size | **Partial** | `lib/fileSignature.ts` sniffs bytes; **bucket itself has no size or MIME limit**; no ClamAV |
| 6.7 | Auth on every route, rate limiting, CORS, short tokens | Done | Phases 1, 2, 6a |
| 6.8 | Generic errors, no stack traces | Done | `middleware/error.ts` |
| 6.9 | Dependency audit + secret scanner | Done | `npm audit`, `scripts/scan-secrets.mjs` |
| 6.10 | `SECURITY.md` and a pre-commit secret hook | **Partial** | Scanner exists with `--staged`; the hook is not installed |

## Phase 7 — Bank integration

**Blocked** in full, on the Union Bank API document. Nothing is built, and nothing should be.

## Phase 8 — Monitoring and alerts

| # | Item | State | Where |
|---|---|---|---|
| | Failed-login bursts, per user and per IP | Done | `services/securityRules.ts` |
| | Odd-hour login | Done | |
| | New device / IP | **Partial** | New-*device* done (Phase 1). Country needs geo-IP |
| | Role and permission changes | Done | Fixed 27 Nov after it fired on every owner login |
| | Bank-detail change | Done | Phase 3 |
| | Large exports | Done | |
| | Chain verification failure | Done | |
| | No recent backup | Done | Not in the plan; added because it happened |
| | Bank API, certificates, statement mismatch | **Blocked** | Phase 7 |
| | Dashboard | Done | `/security` |
| | Email delivery | **Open** | `securityAlertEmails` unset — the page says so |

## Phase 9 — Backup, DR, operations

| # | Item | State | Where |
|---|---|---|---|
| 9.1 | Encrypted daily dump, offsite, retention | Done (script) / **Open** (not scheduled) | `scripts/backup-database.mjs`; **the Task Scheduler entry is not registered** |
| 9.2 | Restore script and a monthly test | Done | `scripts/restore-database.mjs --verify`; refuses to target production |
| 9.3 | Health endpoint and runbook | Done | `/api/health`, `/api/health/db`, [RUNBOOK.md](RUNBOOK.md) |
| 9.4 | Separate configs, no secrets in repo | Done | `.env` gitignored and untracked; scanner clean over 794 files; no `.env` ever committed |
| 9.5 | Offboarding, access review | Done | Disable revokes sessions at once; `scripts/access-review.mjs` |

## Phase 10 — Verification

| # | Item | State |
|---|---|---|
| 10.1 | This checklist | Done |
| 10.2 | Tests, dependency audit, secret scan, DAST | Done — see below |
| 10.3 | Report for the auditor | Done — [VAPT-BRIEF.md](VAPT-BRIEF.md) |

---

## Verification results, 27 Nov 2026

### Tests

`npm test` in `server/` — **84 files, 960 tests, all passing.**

### Dependency audit

Six server findings became three.

| Package | Was | Now |
|---|---|---|
| `xlsx` | HIGH, prototype pollution, **no fix exists** | **Removed.** Replaced with `exceljs` behind `lib/spreadsheet.ts` |
| `qs` / `express` | MODERATE | Fixed |
| `node-cron` / `uuid` | MODERATE | Fixed — upgraded to 4.6.0 |
| `zod` | HIGH, memory exhaustion on oversized input | **Open.** 31 files import it; a breaking upgrade deserving its own change |
| `exceljs` / `uuid` | — | MODERATE, **not reachable**: the advisory is about `uuid` v3/v5/v6 called *with* a `buf`; `exceljs` calls `uuidv4()` with no arguments and we never call `uuid` directly. npm's suggested "fix" is `exceljs@3.4.0`, a downgrade |

Client: 4 moderate, all transitive dev-chain, none reachable at runtime.

### Secret scan

`scripts/scan-secrets.mjs` — **794 tracked files, zero findings.** No `.env` or key file appears anywhere in the history. Proved it still catches real secrets by planting a Supabase service-role JWT and a password: caught all three occurrences.

### Passive scan

A ZAP baseline needs Docker, and Docker Desktop was not running. `scripts/passive-scan.mjs` applies the header, cookie and disclosure rules a baseline reports. **It is not ZAP** — it does not spider and has no rule database. Run the real one when Docker is up:

```
docker run --rm -t ghcr.io/zaproxy/zaproxy:stable zap-baseline.py -t https://www.rvpindustries.co.in
```

Against production: **nothing at MEDIUM or above.** Four LOW findings, all the `Server:` header — `Vercel` and `cloudflare` — which are set by the platforms and cannot be removed.

> The first version of this scanner reported the client as missing CSP and X-Frame-Options. That was **wrong**: it judged the 308 redirect from the apex domain to `www`, which carries almost no headers, rather than the page behind it. Caught by cross-checking with `curl -L`. It follows redirects now.

---

## The shortest list of what is actually open

In the order I would do them.

1. **Register the backup task.** Everything else in Phase 9 works; this one command is the difference between a backup system and two manual backups.
2. **Two-factor on the four privileged accounts.** The code has been there since Phase 1.
3. **`zod` 3 → 4.** The one remaining HIGH advisory.
4. **Set `securityAlertEmails`.** Alerts exist but reach nobody until someone opens the page.
5. **Flip the CSP from Report-Only to enforcing** after a console check.
6. **Convert the remaining hard deletes** — purchases, sales, notes, loans.
7. **Decide the `AuditLog` `REVOKE`**, which unblocks the retention job.
