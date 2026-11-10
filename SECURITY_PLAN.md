# RVP ERP – Security Implementation Plan (for Claude Code)

> Put this file in the ROOT of the ERP code repo. Then run Claude Code in that folder and paste the
> prompts from the section "Prompts to paste" one phase at a time. Do not paste all phases at once.

## Ground rules for Claude Code (applies to every phase)

- First read the codebase and detect the stack (language, framework, database, ORM, auth library, frontend). Reuse what exists; do not introduce a second framework for the same job.
- Work on a new git branch per phase: `security/phase-N-<name>`.
- Every change must have tests (unit + at least one integration test per feature). Run the full test suite before finishing a phase.
- Database changes only through migrations. Never edit existing data destructively.
- Never put secrets in code, logs, test fixtures or git. Use environment variables / a secrets store.
- All permission checks happen on the SERVER. Hiding a button in the UI is not security.
- At the end of each phase: write a short summary in `docs/security/PHASE-N.md` (what changed, how to configure, how to test manually, anything left open).
- If something in this plan does not fit the existing code, stop and ask before redesigning.

## Business context

- ERP for RVP (India). Modules include accounts (vouchers, ledgers, receipts), masters (vendors, customers, bank accounts), and a planned Union Bank of India API integration (balance, statement, receipts via virtual accounts, reconciliation). Payments are NOT done through the ERP.
- Indian context: PAN, Aadhaar, GSTIN, bank account numbers are sensitive. DPDP Act 2023 applies to personal data. CERT-In directions apply for incident reporting and log retention. Annual VAPT by a CERT-In empanelled auditor is planned.

---

## Phase 1 – Login and identity

1. Password hashing with Argon2id or bcrypt (cost >= 12). If old hashes exist, rehash on next successful login.
2. Password policy: min 12 chars, block common/breached passwords (local list), no reuse of last 5, optional expiry setting.
3. MFA (TOTP authenticator app; email/SMS OTP as fallback). Mandatory for roles: admin, finance, accounts, treasury, and anyone with bank-module permission. Recovery codes (hashed).
4. Account lockout: 5 failed attempts -> 15 min lock (configurable) + captcha after 3 failures. Rate-limit login by IP and by username.
5. Sessions: secure, HttpOnly, SameSite cookies (or short-lived access token + rotating refresh token). Idle timeout 15 min, absolute timeout 12 h. Option to allow only one active session per user. Invalidate all sessions on password change / role change / user disable.
6. "Remember device" + alert email on login from a new device/IP.
7. Optional IP allow-list per role (e.g. bank module only from office IP/VPN).
8. Forgot-password flow: single-use, time-limited (15 min) token; same response whether the email exists or not.

## Phase 2 – Roles, permissions, segregation of duties

1. Role-based access control (RBAC): permissions like `voucher.create`, `voucher.approve`, `master.vendor.bank.edit`, `bank.settings.edit`, `report.export`, `user.manage`. Roles are bundles of permissions. Admin UI to manage roles.
2. Data scoping: user can only see companies / branches assigned to them. Enforce in the query layer (one central helper), not per screen.
3. Object-level checks on EVERY read/update/delete endpoint (prevent IDOR: changing an ID in the URL must not expose another company's record). Add a test that tries this.
4. Segregation of duties enforced in code: the creator of a voucher cannot approve it; the person who requests a master change cannot approve it.
5. Approval limits per role (amount thresholds, configurable).
6. Generic maker-checker framework (pending change -> approve/reject, with reason) reusable by vouchers and masters.

## Phase 3 – Master data controls (fraud prevention)

1. Vendor bank details (account no., IFSC, account holder name) changes go through maker-checker. Old details stay active until approved.
2. On approval: send alert to finance head and to the vendor's registered email.
3. Hook for bank account verification (penny-drop / name match) – interface only for now, provider to be plugged later.
4. Same maker-checker for: customer virtual-account mapping, company bank-account master, GSTIN/PAN changes.
5. Full field-level change history (old value -> new value, who, when, IP) for all masters, viewable in UI.

## Phase 4 – Audit trail

1. Central audit log table: timestamp (UTC), user id, IP, user agent, action, entity type, entity id, old values, new values, request id.
2. Log: logins (success/fail), logout, MFA events, every create/update/delete/approve/reject, exports, permission/role changes, settings changes.
3. Tamper-evident: append-only (no update/delete rights for the app DB user on this table) + hash chain (each row stores hash of previous row). A verify command that checks the chain.
4. No hard delete of vouchers/financial entries: cancel or reverse only (status + reversing entry).
5. Period lock: closed months/years cannot be posted into; unlock only by a specific permission, with reason, and audited.
6. Retention setting (default: keep at least 180 days online, archive older; confirm final period with auditor).
7. Audit log viewer with filters (user, date, entity, action) for admins.

## Phase 5 – Data protection

1. Enforce HTTPS (HSTS). TLS 1.2+. Redirect HTTP to HTTPS.
2. Field-level encryption (AES-256-GCM, key from env/secret store, key-version column for rotation) for: bank account numbers, Aadhaar, PAN (and any other field listed in config). Searchable via a separate hashed column where lookup is needed.
3. Masking in UI and APIs by default (XXXXXX1234); full value only with permission `pii.view`, and each reveal is audited.
4. Export controls: permission `report.export`, every export audited, alert on large exports (row threshold configurable), optional watermark (user + time) on PDF exports.
5. Seed/test data: a script to create a masked copy of the production DB for testing.
6. Remove sensitive data from logs (log scrubber for account numbers, PAN, Aadhaar, tokens, passwords).

## Phase 6 – Application hardening (OWASP Top 10)

1. Find and fix any raw SQL string concatenation -> parameterised queries / ORM.
2. Output encoding / XSS protection in templates and frontend; Content-Security-Policy.
3. CSRF protection on all state-changing requests (if cookie-based auth).
4. Server-side validation on every input (schema validation library for the stack).
5. Security headers: CSP, HSTS, X-Content-Type-Options, X-Frame-Options/frame-ancestors, Referrer-Policy, Permissions-Policy.
6. File uploads: allow-list of types (check magic bytes, not just extension), size limit, store outside web root, random file names, virus scan hook (ClamAV).
7. API: auth on every route (deny by default), rate limiting, CORS restricted to own domains, short-lived tokens.
8. Errors: generic messages to users, details only in server logs. No stack traces in production.
9. Dependencies: add dependency audit (npm audit / pip-audit / etc.) and a secrets scanner (gitleaks) to CI; fix high/critical findings.
10. Add a `SECURITY.md` and a pre-commit hook for secret scanning.

## Phase 7 – Bank integration security (Union Bank API module)

1. Separate service/module "bank-gateway"; ERP talks to it, never to the bank directly.
2. Secrets (client id/secret, private keys, certificates) loaded from a secret store / encrypted files; never in DB plain text, code, or UI. Admin UI shows only "configured / expires on".
3. Pluggable crypto layer for the bank's payload encryption + signature (AES session key + RSA, exact spec to be filled from UBI's API document).
4. Webhook endpoint for credit alerts: verify signature, IP allow-list, timestamp window (e.g. 5 min) + nonce store to block replays, idempotent processing by bank transaction id/UTR. Webhook never posts accounting entries by itself; it creates a pending credit that must match a statement line.
5. Certificate/key expiry tracking with alerts 30/15/7 days before.
6. API call log (request/response with masked fields, latency, status) and retry with exponential backoff.
7. Read-only scope: the module must have NO code path that initiates payments.

## Phase 8 – Monitoring and alerts

Alert engine (email; Slack/WhatsApp hook optional) with configurable rules:
- N failed logins for a user/IP, login at odd hours, login from new country/IP
- role/permission changes, new admin user
- vendor bank detail change requested/approved
- large exports
- bank API failures, certificate expiry
- bank statement debit with no matching ERP voucher (from reconciliation)
- audit hash-chain verification failure
Plus a simple security dashboard page for admins.

## Phase 9 – Backup, DR, operations

1. Backup script: daily encrypted DB dump + uploaded files, copy to offsite/cloud storage, retention policy.
2. Restore script + documented monthly restore test.
3. Health-check endpoint and runbook `docs/security/RUNBOOK.md` (backup, restore, key rotation, user offboarding, incident response incl. CERT-In reporting contact steps).
4. Separate configs for dev / test / production; production secrets never in repo.
5. User lifecycle: disable user immediately on exit (one click revokes sessions + tokens); quarterly access-review report (who has which roles, last login).

## Phase 10 – Verification before VAPT

1. Write `docs/security/CHECKLIST.md` mapping every item above to code/tests/config, marking done/pending.
2. Run all tests, dependency audit, secret scan, and a basic DAST scan (OWASP ZAP baseline) against the test environment; fix findings.
3. Produce a short report for the VAPT auditor: architecture, auth design, data flows, where sensitive data is stored and how it is protected.

---

## Prompts to paste (one at a time)

**Step 0 (once):**
```
Read SECURITY_PLAN.md and the whole codebase. Do NOT change code yet.
Tell me: the stack you detected, how auth/users/roles/audit currently work, which items in the plan already exist, which are missing, and any risky code you found (raw SQL, missing permission checks, secrets in code). Then propose the order of work and ask me to confirm.
```

**Each phase:**
```
Implement Phase <N> of SECURITY_PLAN.md following the "Ground rules".
First show me a short plan (files to change, migrations, new tables, libraries to add) and wait for my OK.
Then implement it with tests, run the full test suite, and write docs/security/PHASE-<N>.md.
```

**After each phase (review):**
```
Review the Phase <N> changes as a security auditor. Look for bypasses: missing server-side checks, IDOR, data leaking in logs or APIs, race conditions in approvals, secrets exposure. List findings by severity and fix the high ones.
```

Recommended order: 0 -> 1 -> 2 -> 4 -> 3 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10
(Audit trail before master controls, because master controls write to the audit log.)
