# Brief for the security auditor

RVP Industries ERP · prepared 27 Nov 2026

This describes the system, where sensitive data lives and how it is protected, so testing can start
from facts rather than discovery. [CHECKLIST.md](CHECKLIST.md) maps every control to the code that
implements it and lists what is knowingly open.

---

## 1. What the system is

A tamarind-processing ERP for a single company — purchases from suppliers, milling, sales to
buyers, a weighbridge, and the ledger behind all of it. Roughly 20 internal users, no public
sign-up, no customer-facing portal. Users are staff; buyers and suppliers are *records*, not
accounts.

## 2. Architecture

```
Browser ── HTTPS ──► Vercel (React SPA, static)
    │
    └──── HTTPS ───► Render (Node 22, Express 4, TypeScript)
                          │
                          ├── Supabase Postgres 17  (Prisma 6)
                          └── Supabase Storage      (private bucket)

Also inbound:  Fast2SMS webhooks (WhatsApp), a GPS provider, a Slack bot,
               and an on-site CCTV/weighbridge bridge on the office LAN.
```

- **Client:** React 18 + Vite, served as static files by Vercel. No server-side rendering, no
  secrets in the bundle.
- **Server:** one Express process. All business logic and every authorization decision.
- **Database:** Supabase Postgres, reached through a pooled connection (6543) for the app and a
  direct one (5432) for `pg_dump`.
- **There is no staging environment.** Testing against production needs care and coordination.

## 3. Authentication

| | |
|---|---|
| Credential | Username and password. No social or SSO login |
| Hashing | argon2id (`@node-rs/argon2`); legacy bcrypt hashes are upgraded on next sign-in |
| Policy | Minimum 12 characters, local blocklist with leet-substitution and tail-stripping, **no character-class rules** (NIST SP 800-63B) |
| Second factor | TOTP (`otpauth`), with recovery codes. **Implemented but not enforced, and currently nobody is enrolled** |
| Access token | JWT, 15 minutes, carries `pwdAt` |
| Refresh token | Opaque, rotating, stored as a SHA-256 hash, 12-hour absolute session cap |
| Where tokens live | `localStorage` — a deliberate, recorded trade-off. Mitigated by short lifetimes, server-side session rows and immediate revocation |
| Revocation | A password change, a role change or disabling an account kills every live session at once |
| Lockout | Failed attempts counted; `LoginAttempt` records every outcome with IP and user agent |
| Devices | Two per account; 20-minute idle sign-out; a new device raises an email |

**Worth probing:** token replay after a role change, the refresh rotation, and whether the device
cap can be evaded.

## 4. Authorization

Role-based, with a permission set per role, **deny by default**.

- Every route is matched against one ordered table, `server/src/lib/routePermissions.ts`, first
  match wins.
- `server/scripts/audit-routes.mjs` enumerates all routes mechanically; a test fails the build if
  any authenticated route has no rule, or if a route is public without being on a reviewed list.
- Record-level ownership checks return **404, not 403**, so a record that exists but is not yours
  is indistinguishable from one that does not exist.
- Changes to protected master fields — bank account, GSTIN, email — go through maker-checker with
  approval limits. The requester cannot approve their own request, even as DEVELOPER.

**Worth probing:** horizontal access between records, the maker-checker path, and whether any
route reaches a handler without passing the table.

## 5. Sensitive data, and where it is

| Data | Where | Protection |
|---|---|---|
| Supplier bank account numbers | `Party.bankAccountNumber` | **Masked server-side** by default; full value only with `master.party.bank.view` or `pii.view`, through a separate endpoint that **audits every reveal** |
| GSTINs | `Party`, `Transport`, `CompanyProfile` | Not secret — printed on every invoice |
| Password hashes, TOTP secrets | `User` | argon2id; stripped from the audit trail and from logs by field name |
| Invoices, kata slips, screenshots | Supabase Storage, **private bucket** | Served only via `GET /api/files/:name?exp&sig` — an HMAC token that expires. 15 minutes in-app, 7 days for a link sent over WhatsApp |
| Everything else | Postgres | Supabase encryption at rest |

**No Aadhaar or PAN is stored anywhere.** Field-level encryption was considered and deliberately
deferred — the reasoning is in [PHASE-5.md](PHASE-5.md).

## 6. Audit trail

- Every create, update, upsert and delete is captured by a **Prisma client extension**, not by
  call sites — a new endpoint is audited the day it is written, and an unknown model is audited by
  default.
- Each row hashes its own contents with the previous row's hash. Altering or removing any row
  breaks every hash after it, and `seq` is gapless so a deletion is visible even at the tail.
- It **detects** tampering; it does not prevent it. Prevention would be `REVOKE UPDATE, DELETE` on
  the table, which is documented and **not yet applied**.
- Financial documents are **cancelled, not deleted** — a reversing journal entry is posted so the
  ledger nets to zero. This is done for payments, receipts and set-offs; purchases, sales, notes
  and loans still hard-delete.
- Verify it yourself: `node scripts/verify-audit-chain.mjs` (exits non-zero on a break).

## 7. Monitoring

An hourly job raises alerts for failed-login bursts (per user *and* per IP), odd-hour sign-ins,
privilege changes, large reads, a failing audit chain, and a backup that has stopped. Alerts are
**stored and shown at `/security`**; email is configured separately and is currently unset.

## 8. Backups

Encrypted `pg_dump` (AES-256-GCM), written to a cloud-synced folder on an office PC, 30-day
retention, with a verify step that reads the dump's table of contents without touching a database.
**The scheduled task is not yet registered**, so backups are currently manual.

## 9. Known-open items

Stated plainly, because an auditor finding them is not news and the time is better spent elsewhere.
The full list with reasoning is in [CHECKLIST.md](CHECKLIST.md).

1. **No two-factor is enrolled** on any of the four privileged accounts.
2. **`zod` 3.24** carries a HIGH advisory (memory exhaustion on oversized input). The upgrade
   touches 31 files and is pending.
3. **The nightly backup is not scheduled.**
4. **CSP is Report-Only** on the client.
5. **The audit log is not yet append-only** at the database level.
6. **Uploads have no antivirus step**, and the storage bucket has no size or MIME limit of its own
   (the application enforces both).
7. **Bank integration is not built** — there is no code path that moves money. Phase 7 is blocked
   on the bank's API document.

## 10. Testing this system

- **There is no staging.** Please agree a window before anything active.
- Rate limiting is on. A scan will trip it; that is the control working.
- The audit trail will record everything you do, which is useful evidence afterwards.
- `POST` endpoints create real business records. Please use a test party.
- Useful starting points: `/api/auth/login`, `/api/parties` (masking), `/api/files/:name` (token
  forgery), and anything under `/api/payments` (maker-checker and period locks).

## 11. Contact

See `SECURITY.md` in the repository root.
