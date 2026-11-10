# Phase 6a — Hotfix: live exploitable findings

Branch: `security/phase-6a-hotfix` · Date: 2026-11-10

Out-of-order phase, agreed in [PHASE-0.md](PHASE-0.md) §7: these are the findings that are
exploitable today and that cost a few lines each, so there was no reason to leave them open for
the weeks Phases 1–5 will take. No schema change, no migration, no client change.

## What changed

### H1 — 500 responses no longer leak stack traces

`server/src/middleware/error.ts`

The handler returned `{ error, message, stack }` for every unhandled error, in production too —
file paths, SQL fragments, library internals and anything else in the message, to anyone who
could provoke a 500. It now returns `{ error: 'Internal server error' }` when
`NODE_ENV === 'production'`, and logs the full error as before.

Unchanged on purpose:

- `HttpError` messages are still returned. They are written for the user ("Invalid credentials",
  "This account is already signed in on 2 devices") and the client depends on them.
- `ZodError` details are still returned — the forms need them to mark the offending field.
- Outside production the message and stack are still in the response, because that is where
  they are actually useful.

### H2 — CORS matches whole origins

`server/src/lib/corsOrigin.ts` (new), `server/src/index.ts`

The old rule accepted:

```js
origin.endsWith('.vercel.app') || origin.includes('localhost') || origin.includes('127.0.0.1')
```

which let through `https://rvp-localhost.attacker.com`, `https://127.0.0.1.attacker.com` and
every Vercel deployment on the internet. The new module matches whole origins:

| Origin | Before | After |
|---|---|---|
| `https://www.rvpindustries.co.in` | allow | allow |
| a domain in `CLIENT_ORIGIN` | allow | allow |
| `http://localhost:5173` | allow | allow outside production, **blocked** in production |
| `https://rvp-localhost.attacker.com` | **allow** | blocked |
| `https://someone-elses-app.vercel.app` | **allow** | blocked |
| `https://evil.erp.rvpindustries.com` (subdomain of an allowed origin) | blocked | blocked |
| no `Origin` header | allow | allow |

Two things to know about the shape of this:

- **The production origins are baked in** (`PRODUCTION_ORIGINS` in `corsOrigin.ts`), so an unset
  or wrong `CLIENT_ORIGIN` on Render cannot take the app down. `CLIENT_ORIGIN` adds to that list,
  it does not replace it. This matters because in production the client calls
  `https://rvp-server.onrender.com/api` on its absolute URL rather than through the Vercel
  rewrite, so CORS is load-bearing rather than cosmetic.

  The list is `rvpindustries.co.in` and `www.rvpindustries.co.in` — both, because the apex
  308-redirects to www, so either can be the page's origin depending on how it was opened.
  It deliberately does **not** include `rvp-industries.vercel.app`: that is the Vercel *project*
  name, but no deployment is served there (it answers `DEPLOYMENT_NOT_FOUND`), so allowing it
  would buy nothing, and an unclaimed `*.vercel.app` subdomain is registrable by a stranger.
  See "Correction after live verification" at the end of this document.
- **A rejected origin gets a normal response without the CORS headers**, instead of the old
  `cb(new Error(...))`. The browser blocks the read either way, and the old form surfaced a
  routine rejection as a 500 in the logs. The allow-list is logged once at boot and each
  rejection is logged at `warn`.

Vercel **preview** deployments are no longer allowed automatically. If you want one to talk to the
production API, add its exact origin to `CLIENT_ORIGIN`. Local development is unaffected
(`NODE_ENV` is not `production` there, so localhost is accepted on any port).

### M1 — endpoints that were reachable by anyone, partially closed

`server/src/index.ts`, `server/src/routes/index.ts`, `server/src/middleware/cameraAuth.ts` (new)

| Endpoint | Change |
|---|---|
| `POST /api/weighbridge/cctv/detect-plate` | now requires a signed-in user **or** the cabin bridge key. It ran a billed Gemini call for anonymous callers. |
| `GET /api/weighbridge/print-queue/status` | now behind `printQueueAuth` (JWT or bridge key). The print agent only polls `/pending` and `/complete`, so nothing on the cabin changes. |
| `GET /api/assets/*` | `Access-Control-Allow-Origin: *` replaced by a reflected check against the same allow-list, with `Vary: Origin`. The files stay public — they are company branding, not business data. |

`requireAuthOrCameraBridge` accepts either credential, and both real callers already send one:
the client goes through `api()` with a Bearer token, the bridge sends `x-cctv-bridge-key`. So this
needed no client change and carries no risk to the cabin screen.

**Still open, deferred to Phase 6b:** `GET /cctv/stream`, `/cctv/snapshot`, `/cctv/status` and
`GET /weighbridge/snapshots/:filename`. These are loaded by `<img>` tags, which cannot send an
`Authorization` header, so closing them needs a rotating capability token in the URL plus changes
at about seven client call sites (`useCameraPreview.ts`, `WeighbridgeScreen.tsx`,
`WeighbridgeSlipModal.tsx`). Deferred deliberately rather than rushed into a hotfix, because it
touches the live cabin screen and cannot be verified from a dev machine without the cameras.
**Until then the live camera feed remains viewable by anyone who knows the API host.**

Checked and found already sound, so left alone: `POST /cctv/broadcast` verifies the bridge key;
`snapshots/:filename` runs the filename through `path.basename`, so there is no traversal; and the
kata-slip PDF/JPG routes verify a timing-safe HMAC token.

### L1 — hardcoded fallback secret removed

`server/src/lib/cameraBridgeKey.ts` (new), `server/src/controllers/weighbridge.controller.ts`

`getExpectedBridgeKey()` fell back to the literal `'rvp-default-kata-secret-key-2026'` when
`JWT_SECRET` was unset. It now throws instead. Unreachable in a running server —
`assertJwtSecret()` already refuses to boot without `JWT_SECRET` — but it was a published
credential sitting in the repository, and any scanner would have flagged it.

The key logic moved to `lib/cameraBridgeKey.ts` so route middleware can check it without
importing the whole weighbridge controller (`index.ts` imports that controller lazily to keep boot
light). The controller re-exports `isTrustedCameraBridge`, so every existing import still works.
The order of checks was also flipped so that a caller presenting **no** key is simply "not the
bridge" rather than a server-configuration error.

### L2 — `.env.example` completed

53 environment variables were read by the code but undocumented, so a fresh deployment silently
fell back to derived defaults. `server/.env.example` now documents the security-relevant and
operational ones — `NODE_ENV`, `LOG_LEVEL`, `CRON_SECRET`, `KATA_CABIN_ACCESS_KEY`,
`KATA_CABIN_USERNAME`, `CCTV_BRIDGE_KEY`, the camera credentials, `RESEND_WEBHOOK_SECRET`, the
Fast2SMS and Razorpay keys, and the rest. The `FAST2SMS_TMPL_*` template ids are left pointed at
`render.yaml`, where they are already listed with their approval notes.

### L3 — CI and a pre-commit hook

- `.github/workflows/security.yml` — the repository's first CI workflow. `npm audit
  --audit-level=high` for `server/` and `client/`, plus gitleaks over the full history. It only
  reports; it does not build or deploy.

  The audit step is `continue-on-error: true` for now. The repository currently has **17
  high/critical findings in `server/` and 8 in `client/`** — almost all transitive, several
  dev-only (`vitest`, `tinypool`, `vite`, `postcss`, `source-map-js`) — so a blocking job would
  have been red on every PR from day one, which is the fastest way to teach everyone to ignore
  it. Upgrading 17 packages (`zod` 3 → 4 among them) is not a hotfix; it is the first task of
  Phase 6b, after which `continue-on-error` should be deleted so a *new* finding blocks.

  One deserves attention sooner than the rest: **`proxy-addr` (critical, IP spoofing via
  IPv4-mapped IPv6 trust subnet).** This server sets `trust proxy` and the login rate limiter
  keys on the client IP, so a spoofable IP weakens the one brute-force control that exists until
  Phase 1 lands. The runtime-relevant remainder: `body-parser`, `axios`, `follow-redirects`,
  `sharp`, `xlsx`, `zod`, `nanoid`, `ip-address`.
- `.githooks/pre-commit` — local secret scan over staged additions. Refuses `.env` files and
  matches credential *formats* (private key blocks, `xoxb-`/`xapp-`, `AKIA…`, `AIza…`,
  `rzp_live_`, `sk_live_`, `re_…`, a three-part JWT, a Postgres URL with an inline password)
  rather than keywords, so code that merely mentions "secret" does not trip it.
- `SECURITY.md` — reporting process, scope, DPDP/CERT-In handling rules, secret policy.

### Configuration change required

`render.yaml` now sets `NODE_ENV=production` explicitly. Render usually defaults to this, but
both H1 and H2 key off it, so relying on a default would have meant the hardening silently did
nothing. **If you deploy from the dashboard rather than this blueprint, confirm `NODE_ENV` is set
to `production` on the service before trusting either fix.**

## How to configure

Nothing is required for the app to keep working — the production origin is built in and
`NODE_ENV` comes from `render.yaml`.

Two optional steps:

```bash
# Enable the local pre-commit secret scan, once per clone
git config core.hooksPath .githooks
```

```
# On Render, only if you add a custom domain or want a preview deploy to reach
# the production API (comma-separated, no trailing slash)
CLIENT_ORIGIN=https://erp.rvpindustries.com,https://rvp-industries-git-main-xyz.vercel.app
```

## How to test manually

```bash
# 1. A look-alike origin gets no CORS header (it used to get one)
curl -sD - -o /dev/null https://rvp-server.onrender.com/api/health \
  -H 'Origin: https://rvp-localhost.attacker.com' | grep -i access-control
# expect: no output

# 2. The real client still does
curl -sD - -o /dev/null https://rvp-server.onrender.com/api/health \
  -H 'Origin: https://www.rvpindustries.co.in' | grep -i access-control
# expect: access-control-allow-origin: https://www.rvpindustries.co.in

# 3. Plate detection is no longer anonymous
curl -s -X POST https://rvp-server.onrender.com/api/weighbridge/cctv/detect-plate
# expect: {"error":"Missing or malformed Authorization header"}

# 4. No stack trace in a 500 (provoke one however you like; the body must be
#    exactly {"error":"Internal server error"})
```

In the app itself: sign in, open the weighbridge screen, confirm the camera previews still load
and that "detect plate" still reads a number — those are the two paths this phase could plausibly
have broken.

## Tests

`npm test` in `server/` — **35 files, 347 tests, all passing.** 37 are new:

- `src/lib/corsOrigin.test.ts` (15) — allow-list parsing and the origin decision, including a
  case for each bypass the old rule permitted.
- `src/lib/cameraBridgeKey.test.ts` (10) — key precedence, the constant-time compare, that an
  unconfigured server throws rather than falling back, and that the old hardcoded default is no
  longer accepted.
- `tests/httpSecurity.test.ts` (12) — **the first integration tests in this repo.** They mount the
  real `cors`, `helmet` and `errorHandler` on an Express app and drive it over HTTP with
  `supertest`, asserting on what a client actually receives: no stack in production, `HttpError`
  messages preserved, the CORS header present or withheld per origin (including on the preflight),
  no-`Origin` callers still served, and the helmet defaults present.

`supertest` and `@types/supertest` were added as dev dependencies. These tests need no database,
which is what makes them a usable harness for Phase 1 — the ground rule asking for an integration
test per feature had nothing to build on before this.

`npm run typecheck` — clean.

## Also fixed: a pre-existing failing test

`src/services/whatsappLanguage.test.ts` was already failing on `main`, unrelated to this work:
it expected template id `31637` for `INBOUND_MESSAGE` while `whatsapp.service.ts` has `33710`
(the id of `inbound_erp_alert` as approved on +917207146094, per the comment beside it). The test
was the stale side, so the expectation was updated. Mentioned here because the ground rules
require a green suite at the end of each phase, and the suite could not go green otherwise.

## Left open

| Item | Where it goes |
|---|---|
| Camera endpoints still anonymous (`/cctv/stream`, `/cctv/snapshot`, `/cctv/status`, `/weighbridge/snapshots/:filename`) | **Phase 6b** — needs a capability token and ~7 client call-site changes |
| No CSP or frame protection on the SPA (M3) | Phase 6b |
| Uploads: extension-only check, no magic bytes, no AV hook (M5) | Phase 6b |
| Invoice files in a public Supabase bucket on never-expiring URLs (M2) | Phase 6b / Phase 5 |
| Request bodies logged verbatim in two places (M6) | Phase 5 (log scrubber) |
| H3 (localStorage token, no revocation), H4 (flat authorization), H5 (no audit trail) | Phases 1, 2, 4 as planned |
| `SECURITY.md` carries a placeholder contact address | fill in before sharing the repo or handing it to the auditor |

The `npm audit` job may fail on its first run — it has never been run against this repository.
Triage those findings as the first task of Phase 6b rather than inside this hotfix.

---

## Correction after live verification

Phase 6a shipped to `main` and auto-deployed, and the deployed API was then probed to confirm the
changes took effect. Everything verified, and one mistake in this phase's own work surfaced.

Verified against `https://rvp-server.onrender.com`:

| Check | Result |
|---|---|
| `GET /api/health` | 200 `OK`; `/api/health/db` reported `{"db":"ok","ms":7}` |
| `Origin: https://www.rvpindustries.co.in` | ACAO echoed — the real client still works |
| `Origin: https://rvp-localhost.attacker.com` | no ACAO (was allowed before) |
| `Origin: https://someone-elses-app.vercel.app` | no ACAO (was allowed before) |
| `Origin: http://localhost:5173` | no ACAO — which also **proves `NODE_ENV=production` is set on the service**, since localhost is accepted only when it is not. The same flag gates the stack-trace fix, so H1 is live too. |
| `POST /cctv/detect-plate` with no credentials | 401 (was anonymous, and ran a billed Gemini call) |
| `GET /print-queue/status` with no credentials | 401 |
| `/api/assets/*` | ACAO echoed for the real client, absent for a stranger (was `*`) |
| `GET /cctv/status`, `GET /cctv/snapshot` | still 200, so the cabin path is not broken |

**The mistake.** `PRODUCTION_ORIGINS` was initially set to `https://rvp-industries.vercel.app`,
taken from the Vercel project name in `.vercel/project.json`. That host serves nothing — it
answers `X-Vercel-Error: DEPLOYMENT_NOT_FOUND`. The production client is actually the custom
domain `https://rvpindustries.co.in`, which 308-redirects to `www.`.

Two consequences, one harmless and one not:

- The claimed safety net — "an unset `CLIENT_ORIGIN` cannot take the app down" — did not exist.
  Production kept working only because `CLIENT_ORIGIN` on Render is correctly configured with the
  real domain (confirmed: the live API echoes ACAO for both `rvpindustries.co.in` and
  `www.rvpindustries.co.in`). Had it been unset, removing the old `*.vercel.app` wildcard would
  have broken the client the moment this deployed.
- Allow-listing an unclaimed `*.vercel.app` subdomain is a small latent hazard in its own right,
  since anyone can register that project name on Vercel later and would then hold an allowed
  origin.

`PRODUCTION_ORIGINS` is now the two real domains, and the tests, `SECURITY.md` and the table above
were repointed with it. The lesson for later phases: confirm a production hostname by asking it
for a response, not by reading a project name out of a config file.
