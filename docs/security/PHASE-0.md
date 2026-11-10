# Phase 0 — Codebase audit against SECURITY_PLAN.md

Read-only reconnaissance. **No code was changed in this phase.** The only files added are
`SECURITY_PLAN.md` in the repo root (the plan asks for it there) and this document.

Date: 2026-11-10 · Branch: `main`

---

## 1. Stack detected

| Layer | What's actually here |
|---|---|
| Server | Node + **Express 4.21**, TypeScript ESM (`tsx watch` dev, `tsc` build, `node dist/index.js` prod) |
| ORM / DB | **Prisma 6** → **PostgreSQL on Supabase** (`DATABASE_URL` pooled 6543, `DIRECT_URL` 5432). 2,425-line schema, ~120 models |
| Auth | **Hand-rolled** — `bcryptjs` + `jsonwebtoken` (HS256). No Passport / Auth.js / Supabase Auth |
| Validation | **zod 3** (19 schema files) |
| Security libs present | `helmet` 8, `express-rate-limit` 8 |
| Logging | `winston` (JSON to console; no file or SIEM transport) |
| Files | `multer` → **Supabase Storage** (public bucket, capability URLs) |
| Client | **React 18 + Vite 6 + TS**, react-router 6, TanStack Query, Tailwind 4, radix-ui |
| Integrations | Slack Bolt (Socket Mode), Resend (email), Fast2SMS (WhatsApp), Google Gemini, TaxPro (e-invoice), Tally agent, Razorpay (dormant), CP PLUS CCTV, serial weighbridge |
| Deploy | Server on **Render**, client on **Vercel** (rewrites `/api/*` → `rvp-server.onrender.com`), DB + storage on **Supabase** |
| Tests | **vitest**, 32 test files — all unit-level. No integration/HTTP harness (no supertest, no test DB) |
| CI | **None.** No `.github/`, no pre-commit hooks, no `SECURITY.md` |

## 2. How auth, users, roles and audit work today

**Login** (`server/src/controllers/auth.controller.ts`)

- username + password + `deviceId`; `bcrypt.compare` runs against a **constant dummy hash** when
  the username is unknown, so response timing does not leak account existence — good.
- bcrypt **cost 10**. Password minimum **6 characters** (zod schema in `user.controller.ts`).
- `loginLimiter`: 10 attempts / 15 min **per IP**, with `skipSuccessfulRequests: true`.

**Sessions** (`server/src/lib/sessionPolicy.ts`, `server/src/middleware/auth.ts`)

- JWT in `Authorization: Bearer`, **7-day expiry**, held in the browser's **localStorage**.
- JWT payload is `{ userId, role, sid, scope?, name? }`; `sid` points at a `UserSession` row, one
  per signed-in device.
- **2 devices max** per account (DEVELOPER exempt). **20-minute idle** window + 90s grace; stale
  rows are deleted at login and on the first request past the window. The `lastSeenAt` write is
  throttled to 30s through an in-process `Map`, so a session revoked by another instance is
  noticed within 30s.
- `JWT_SECRET` is asserted at boot (`assertJwtSecret()`), minimum 16 chars — good fail-fast.
- Non-browser principals: the Slack bot uses `sid: 'service'` (no session row, never idles); the
  Tally agent presents a shared `TALLY_SYNC_TOKEN`; the CCTV bridge presents `X-CCTV-Bridge-Key`
  (timing-safe compare); cron uses `X-Cron-Secret`; the kata cabin exchanges an installation key
  for a `scope: 'KATA_CABIN'` token that is path-restricted to `/weighbridge` plus three
  read-only GETs.

**Roles**

- `enum Role { ADMIN, USER, OWNER, DEVELOPER }` — flat. **No permissions table, no role→permission
  mapping, no company/branch scoping** (single-company deployment, one `CompanyProfile` row).
- `requireRole(...)` exists and is a proper server-side check — but it is used in **only 8 of 34
  route files** (~27 call sites against **~393 route definitions**). In practice **a plain `USER`
  can reach almost every business endpoint**, including creating and deleting payments, receipts,
  purchases, sale orders and loans, and editing any party's bank details.
- Gated today: `/users`, `/system`, settings **writes**, `/archive`, `/subscription`, `/support`,
  `/whatsapp`, `/wishes`.
- Client-side there are only ~15 role checks, and all of them are `=== 'DEVELOPER'`.

**Audit**

- **There is no audit log.** No table, no middleware, no viewer.
- Attribution is scattered and inconsistent: `PurchaseOrder.createdBy`,
  `ManualHamaliCost.createdBy`, `HamaliVerification.createdBy`,
  `MaintenanceConfig.updatedById/updatedByName`, `ChallanSerialCounter.createdBy`.
- `EmailLog` and `WhatsAppLog` are message trails, not an audit trail.
- **44 `DELETE` routes** hard-delete rows, financial documents among them (payments, receipts,
  purchases, sale orders, credit/debit notes, loans, set-offs). There is no cancel/reverse model.
- No period lock — any date can be posted into, closed years included.

## 3. Plan items that already exist

| Plan item | State |
|---|---|
| 1.1 bcrypt hashing | ✅ present, but **cost 10** (plan wants ≥12 or Argon2id) |
| 1.4 login rate limiting | 🟡 per-IP only; no per-username limit, no lockout counter, no captcha |
| 1.5 idle timeout / one session per user | 🟡 20-min idle (plan says 15) + 2-device cap; **no absolute timeout** (JWT lives 7d); not cookie-based |
| 1.6 device record | 🟡 `UserSession` already stores `deviceId`, `userAgent`, `ip` — groundwork is there, no alerting |
| 2.1 server-side role checks | 🟡 mechanism exists (`requireRole`), barely applied |
| 5.1 HTTPS / HSTS | ✅ TLS at the Render/Vercel edge; `helmet()` sets HSTS on API responses |
| 6.1 no SQL injection | ✅ **zero** `$queryRawUnsafe` / `$executeRawUnsafe`; the only raw SQL is two tagged-template `SELECT 1` health probes |
| 6.2 XSS | 🟡 React escapes by default; **no CSP anywhere** |
| 6.3 CSRF | ✅ largely N/A — Bearer tokens, not cookies |
| 6.4 server-side validation | ✅ zod across 19 schema files |
| 6.5 security headers | 🟡 `helmet()` on the API only; nothing on the Vercel-served SPA |
| 6.6 uploads | 🟡 extension allow-list, 8–10 MB caps, 16-byte random object names; **no magic-byte check, no AV** |
| 6.7 rate limiting / CORS | 🟡 four limiters in place; **CORS allow-list is effectively open** (finding H2) |
| 9.3 health check | ✅ `/api/health` (liveness) and `/api/health/db` (real probe, bounded, small bodies) — well done |

## 4. Plan items entirely missing

- **Phase 1:** MFA/TOTP, recovery codes, password policy (length / breach list / reuse history /
  expiry), account lockout, captcha, per-username rate limit, cookie sessions, absolute timeout,
  session invalidation on password or role change, new-device alerts, per-role IP allow-list,
  forgot-password flow, self-service password change.
- **Phase 2:** permission model, role admin UI, maker-checker framework, segregation of duties,
  approval limits, object-level authorization tests.
- **Phase 3:** vendor bank-detail approval, change alerts, penny-drop hook, field-level change
  history. Today `Party.bankAccountNumber` / `bankIfsc` are editable straight through the party
  update route by any authenticated user, with no record of who changed what.
- **Phase 4:** the entire audit trail, hash chain, no-hard-delete rule, period lock, retention
  policy, audit viewer.
- **Phase 5:** field-level encryption, UI/API masking, `pii.view` permission, export controls and
  export alerts, masked-DB seed script, log scrubber.
- **Phase 6:** CSP, magic-byte upload checks, dependency audit, secret scanning, CI, `SECURITY.md`.
- **Phase 7:** no bank module of any kind exists. Also **blocked** — needs the UBI API document.
- **Phase 8:** no alert engine, no security dashboard. (Resend + Fast2SMS + node-cron are good
  foundations to build on.)
- **Phase 9:** no backup/restore scripts in the repo, no runbook, no access-review report, no
  one-click offboarding (user delete is a hard delete).
- **Phase 10:** nothing.

## 5. Risky code found

### HIGH

**H1 — Stack traces returned to the client on every 500.**
`server/src/middleware/error.ts:30-33` sends `{ error, message, stack }` for any unhandled error,
in production too. This leaks file paths, SQL fragments and library internals, and directly
contradicts plan item 6.8.

**H2 — CORS allow-list is effectively open.**
`server/src/index.ts:31-43`:

```js
origin.endsWith('.vercel.app') || origin.includes('localhost') || origin.includes('127.0.0.1')
```

`https://rvp-localhost.attacker.com` satisfies `includes('localhost')`, and *any* attacker's Vercel
preview deployment satisfies the first clause. Combined with H3 (token in localStorage) this
removes the browser-origin barrier entirely. Plan 6.7 wants CORS restricted to own domains.

**H3 — Session token in `localStorage`, 7-day life, no absolute timeout, no revocation on
credential change.** `client/src/lib/api.ts:52-60`. Any XSS yields a 7-day bearer token. Changing a
password or demoting a role does **not** invalidate issued tokens — only deleting the
`UserSession` row does, and nothing does that on either event.

**H4 — Authorization is effectively flat.** ~393 routes, ~27 `requireRole` guards. A `USER` account
can create and delete payments, receipts, purchases, sales, loans and set-offs, and can rewrite any
party's bank account number — with no record that it happened (see H5). This is the largest single
gap against Phases 2–4.

**H5 — No audit trail at all, plus 44 hard-delete routes on financial documents.** There is no way
to answer "who changed this vendor's account number", nor to detect that a payment row was deleted.
For a DPDP / CERT-In posture and for the planned VAPT, this is the item an auditor will open with.

### MEDIUM

**M1 — Unauthenticated public endpoints beyond login.** Registered before `requireAuth`:
`GET /api/weighbridge/cctv/stream`, `/snapshot`, `/status`,
`POST /api/weighbridge/cctv/detect-plate`, `GET /api/weighbridge/snapshots/:filename`,
`GET /api/weighbridge/print-queue/status`, and the `/api/assets/*` static mount — the last three
and the camera routes all with `Access-Control-Allow-Origin: *`. Anyone on the internet who knows
the host can watch the premises live, and can run up Gemini charges through `detect-plate`.
*Verified NOT vulnerable:* `/cctv/broadcast` does check the bridge key; `snapshots/:filename` uses
`path.basename`, so there is no traversal; the kata-slip PDF/JPG routes do verify a timing-safe
HMAC token. Those three are fine as they are.

**M2 — Uploaded invoice files live in a *public* Supabase bucket.** `server/src/lib/upload.ts` uses
`getPublicUrl`. Object names are 16 random bytes, so these are capability URLs — but they never
expire, and the URLs travel through WhatsApp and email. Plan 5.2/5.3 implies signed, expiring URLs.

**M3 — No CSP and no frame protection on the SPA.** `client/index.html` has no CSP meta tag and
`vercel.json` sets no headers; `helmet()` only covers API responses served from Render.

**M4 — Sensitive fields stored in plaintext with no masking.** `Party.bankAccountNumber`,
`Party.bankIfsc`, `Party.gstin`, `CompanyProfile.bankAccountNumber` / `bankBranchIfsc` are returned
in full to every authenticated caller. No PAN or Aadhaar columns exist yet, so Phase 5's encryption
scope is narrower than the plan assumes.

**M5 — Upload type check is extension-only.** The `fileFilter` in `server/src/lib/upload.ts` trusts
`path.extname(file.originalname)`; there is no magic-byte sniffing and no AV hook (plan 6.6).

**M6 — Request bodies logged verbatim in two places.**
`server/src/controllers/weighbridge.controller.ts:618` and
`server/src/controllers/whatsapp.controller.ts:1174` (the latter logs
`JSON.stringify(req.body).slice(0, 500)`). Plan 5.6 wants a log scrubber.

### LOW

**L1 — Hardcoded fallback secret in the repo.**
`server/src/controllers/weighbridge.controller.ts:33`:
`process.env.JWT_SECRET || 'rvp-default-kata-secret-key-2026'`. Unreachable in practice, because
`assertJwtSecret()` fails boot without `JWT_SECRET` — but it is a secret literal in version
control, and any scanner (and the VAPT auditor) will flag it.

**L2 — `.env.example` is incomplete.** `CRON_SECRET`, `KATA_CABIN_ACCESS_KEY`,
`KATA_CABIN_USERNAME`, `CCTV_BRIDGE_KEY`, and the Fast2SMS, Razorpay and TaxPro variables are read
by the code but undocumented, so a fresh deployment silently falls back to derived defaults.

**L3 — No dependency audit, no secret scanner, no CI, no `SECURITY.md`, no pre-commit hooks.**

**Checked and clean:** no `$queryRawUnsafe` / `$executeRawUnsafe` anywhere; no hardcoded credential
literals in `server/src` beyond L1; no `.env` file tracked in git (only `.env.example`);
`timingSafeEqual` used correctly for the cabin key, the bridge key and slip tokens; `trust proxy`
is set, so the rate limiters key on real client IPs.

## 6. Where the plan does not fit this codebase

Each of these needs a decision before the phase it belongs to.

1. **"Database changes only through migrations" vs. this repo's standing rule.** `server/.env`
   points directly at Supabase, and the established practice here is `prisma db push` —
   `migrate dev` / `migrate reset` are off-limits because they drop data. `prisma/migrations/`
   exists but is stale relative to the live schema.
   *Proposal:* keep applying with `db push`, and additionally commit a reviewable SQL file per
   phase generated by `prisma migrate diff --script`, so the auditor still gets a change trail.
   Never run `migrate dev`.

2. **"At least one integration test per feature."** There is no HTTP test harness — all 32 vitest
   files are unit tests and there is no test database.
   *Proposal:* Phase 1 adds `supertest` plus a disposable local Postgres (the existing
   `docker-compose.yml`) as a one-off investment, so later phases can satisfy this rule.

3. **Phase 2.2 data scoping and 2.3 IDOR assume multi-company, multi-branch.** This is a
   single-company deployment — records carry no `companyId` / `branchId`, and every authenticated
   user is entitled to the one company's data. Classic cross-tenant IDOR does not apply.
   *Proposal:* reinterpret 2.2/2.3 as **permission** scoping rather than tenancy scoping, and keep
   the object-level ownership tests for what genuinely is per-user (`UserNote`, `SupportTicket`,
   `UserSession`). Flagging rather than silently redesigning.

4. **Phase 1.3 names roles that do not exist** (finance, accounts, treasury). The current roles are
   ADMIN / USER / OWNER / DEVELOPER.
   *Proposal:* require MFA for ADMIN, OWNER and DEVELOPER in Phase 1, then switch the trigger to
   the new `bank.*` permissions once Phase 2 lands.

5. **Phase 1.5 cookie sessions is a cross-cutting change.** Moving off localStorage Bearer tokens
   touches the client, the Slack bot, the Tally agent, the CCTV bridge, the print agent and the
   kata cabin — all of which authenticate with headers and must keep working. The good news:
   because `vercel.json` proxies `/api/*`, cookies would be **first-party** on the Vercel domain,
   so `SameSite=Lax` is viable.
   *Decision needed:* a full cookie migration in Phase 1, or keep Bearer with a short-lived access
   token plus a rotating refresh token (plan 1.5 allows either) and leave the machine clients
   untouched? **Recommendation: the latter.**

6. **Phase 7 is blocked** — it needs the Union Bank of India API document for the payload
   encryption and signature spec. Everything up to the pluggable crypto boundary can be built
   without it.

## 7. Proposed order of work

The plan recommends `0 → 1 → 2 → 4 → 3 → 5 → 6 → 7 → 8 → 9 → 10`. I suggest one deviation: **pull
the four cheap, live-exploitable Phase 6 fixes forward into a "Phase 6a" hotfix branch first.** H1,
H2, M1 and L1 are each a few lines, carry no schema change and no UX change, and there is no reason
to leave them open for the weeks the earlier phases will take.

| Order | Phase | Why here |
|---|---|---|
| 1 | **6a — hotfix** (H1 stack leak, H2 CORS, M1 public endpoints, L1 hardcoded secret, plus `SECURITY.md`, `npm audit` and gitleaks in CI) | Hours of work; closes the live holes |
| 2 | **1 — login & identity** (plus the supertest / test-DB harness) | Everything else layers on identity |
| 3 | **2 — RBAC, SoD, maker-checker** | Fixes H4; every later phase references permissions |
| 4 | **4 — audit trail, no-hard-delete, period lock** | Fixes H5; master controls write into it |
| 5 | **3 — master data controls** | Needs both 2 and 4 in place |
| 6 | **5 — data protection** (encryption, masking, export control, log scrubber) | Needs `pii.view` from 2 and the audit log from 4 |
| 7 | **6b — remaining hardening** (CSP, magic bytes, AV hook, signed storage URLs) | Independent |
| 8 | **8 — monitoring & alerts** | Consumes audit and master-change events |
| 9 | **9 — backup, DR, operations** | Independent, ops-facing |
| 10 | **7 — bank gateway** | Blocked on the UBI API document |
| 11 | **10 — pre-VAPT verification** | Must be last |

Each phase on its own branch `security/phase-N-<name>`, with a `docs/security/PHASE-N.md`, followed
by the plan's reviewer pass.
