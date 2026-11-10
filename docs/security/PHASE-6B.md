# Phase 6b — Remaining application hardening

Branch: `security/phase-6b-hardening` · Date: 2026-11-10

Picks up what [Phase 6a](PHASE-6A.md) deliberately left: the weighbridge endpoints that were
still anonymous, a CSP for the SPA, real content checks on uploads, and the dependency triage.
No schema change, no migration.

---

## 1. The anonymous weighbridge surface — closed

### What was open, and the part Phase 0 missed

Phase 0 flagged the camera endpoints. It did **not** flag the scale endpoints sitting beside
them, which were worse. Both sets are registered at app level in `index.ts`, ahead of the `/api`
router — deliberately, so a long-lived MJPEG or SSE connection cannot consume the rate limiter's
budget. That placement also puts them ahead of `requireAuth`.

Verified anonymously against production before the fix:

```
$ curl https://rvp-server.onrender.com/api/weighbridge/cctv/snapshot?cam=1
HTTP 200 — 574,687 bytes of live JPEG from the weighbridge camera

$ curl https://rvp-server.onrender.com/api/weighbridge/scale/live
{"liveWeight":0,"isStable":true,"rawText":"000000♥↵",…,"port":"COM4","baudRate":2400}
```

The two POSTs were the serious ones. `POST /scale/broadcast` sets the live weight every operator
sees, and `POST /scale/config` changes the server's serial port — both unauthenticated, from
anywhere. That is a tamper vector on the measurement purchases and kata fees are billed on, not
merely an information leak. They were not probed in production for obvious reasons; the code is
unambiguous (no middleware, no internal check).

### The mechanism

`<img src>` and `EventSource` cannot send an `Authorization` header, which is why these routes
were anonymous in the first place. So reads accept a capability token in the query string, and
writes do not.

**`server/src/lib/mediaAccessToken.ts`** — a rolling HMAC over a 6-hour window, keyed on
`JWT_SECRET`. Verification accepts the current and previous window, so a screen left open across
a boundary keeps working; effective validity is 6–12 hours. The token is:

- not tied to a user, so a leaked one reveals nothing about who held it;
- scoped to reading media and nothing else;
- invalidated by rotating `JWT_SECRET`, which is the behaviour you want;
- never accepted for a write.

That last point is the design's centre. A token in a URL ends up in browser history, in
`Referer` headers and in every proxy log on the way, so it must not be able to change what an
operator sees.

**`server/src/middleware/mediaAuth.ts`** — two gates:

| | bridge key | Bearer token | `?k=` token |
|---|---|---|---|
| `requireMediaRead` | ✅ | ✅ | ✅ |
| `requireMediaWrite` | ✅ | ✅ | ❌ 403 |

`requireMediaWrite` returns an explicit 403 ("A media access token cannot authorise this
request; sign in instead") rather than falling through to a bare "missing Authorization header",
which would send someone debugging the wrong problem.

**`GET /api/weighbridge/media-token`** mints one. Authenticated, and the only way to get one.

### Applied to

| Endpoint | Gate |
|---|---|
| `GET /cctv/snapshot`, `/cctv/stream`, `/cctv/status` | `requireMediaRead` |
| `GET /weighbridge/snapshots/:filename` | `requireMediaRead` |
| `GET /scale/live`, `/scale/stream` | `requireMediaRead` |
| `GET /scale/ports` | `requireMediaWrite` — it enumerates the host's serial hardware |
| `POST /scale/config`, `/scale/broadcast` | `requireMediaWrite` |
| `POST /cctv/broadcast` | unchanged — verifies the bridge key inside the handler |

The duplicate registrations in `routes/index.ts` are gated identically. They are shadowed by the
app-level ones today, but a future change that drops those must not silently reopen the routes.

### Client side

The useful discovery was that nearly every one of these URLs is already built by
`getScaleApiUrl()`, so one change covers most call sites rather than thirteen. It now appends the
token for the six read paths. The LAN bridge matches on pathname and reads only `cam`, so the
extra parameter is ignored there — one code path, cloud or LAN.

- **`client/src/lib/mediaToken.ts`** — fetches, caches (memory + `localStorage`, both reads and
  writes wrapped in try/catch) and appends the token. Re-mints 10 minutes before expiry.
- **`client/src/lib/useMediaToken.ts`** — ensures a token exists and re-renders when it lands, so
  the next `<img src>` carries it. Used by `ScaleProvider`, `useCameraPreview` and
  `WeighbridgeSlipModal`.
- **`client/src/lib/apiBase.ts`** (new) — `API_BASE` and the token helpers moved here so
  `mediaToken.ts` can use them without an import cycle (`api.ts` now depends on `mediaToken.ts`).
  `api.ts` re-exports all of it, so every existing `import { getToken } from './api'` is
  unaffected.
- The three scale **writes** in `scaleContext.tsx` send `Authorization` via a new `authHeaders()`
  helper. They bypass `api()` because they post several times a second and must not go through
  its deadline wrapper.
- `clearMediaToken()` on sign-out, so the token does not outlive the session in `localStorage`.
- The absolute URLs that bypass `getScaleApiUrl` — `WeighbridgeSlipModal.resolveAbsoluteCamUrl`
  and the two snapshot fallbacks in `WeighbridgeScreen` — call `withMediaToken` directly. The
  Supabase storage branch is left alone; those URLs carry their own capability.

**Needs a human check after deploy.** This touches live equipment and cannot be exercised from a
dev machine: no cameras, no scale. Open the weighbridge screen and confirm the camera previews
load, the live weight updates, "detect plate" reads a number, and the slip prints with its
images. The cabin screen uses the same paths through its kiosk token, which `requireAuth`
accepts, and `/weighbridge/media-token` is reachable under the `KATA_CABIN` scope.

## 2. CSP and security headers on the SPA

`vercel.json` serves no headers at all today; `helmet()` only covers API responses from Render.
Added: `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`,
`Cross-Origin-Opener-Policy`, and a CSP.

**The CSP ships as `Content-Security-Policy-Report-Only`.** Violations appear in the browser
console; nothing is blocked. The deployed SPA could not be exercised from here, and a CSP that
breaks the cabin screen is worse than no CSP.

**To enforce it:** open the app and exercise the weighbridge, slip printing, invoice views and
the Telugu/Tamil font pages; confirm the console shows no CSP reports; then rename the header key
to `Content-Security-Policy` and redeploy.

Two details that the policy had to accommodate, both found by reading rather than guessing:

- `X-Frame-Options: SAMEORIGIN`, not `DENY` — `WeighbridgeSlipModal` prints through a same-origin
  iframe it creates itself.
- `Permissions-Policy` includes `serial=(self)` — the cabin reads the weighbridge over the Web
  Serial API, and a blanket restrictive policy would have disabled it.

The policy also allows `http://127.0.0.1:4004` in `img-src` and `connect-src` for the LAN bridge.
If `VITE_LOCAL_BRIDGE_PORT` is ever changed from 4004, or `localStorage.rvp_local_bridge` points
at another origin, that origin must be added too.

`vercel.json` carries no `comment` keys: Vercel validates the file strictly and an unknown
property fails the build.

## 3. Uploads are identified by their bytes

`server/src/lib/upload.ts` trusted `path.extname(file.originalname)` — a string the client
chooses. Renaming `payload.html` to `invoice.pdf` got past it and into Supabase Storage, which is
a **public** bucket, so a stored HTML or SVG file would execute as a page on that origin and its
capability URL could be handed to anyone.

**`server/src/lib/fileSignature.ts`** sniffs the magic bytes and accepts only PDF, JPEG, PNG,
WebP and GIF. The extension *and* `Content-Type` written to storage now come from the sniffed
type, never from the upload. Deliberately strict: a signature must be at offset 0, so a polyglot
with an HTML prologue and a JPEG header further in is rejected — the browser would treat that as
HTML, which is the whole problem. WebP checks both the `RIFF` tag and the `WEBP` tag at offset 8,
so a WAV is not mistaken for an image.

No ClamAV hook yet (plan item 6.6 asks for one). Rejecting everything that is not a PDF or an
image removes most of what a scanner would catch; the hook is still worth adding when there is
somewhere to run it.

## 4. Dependency triage

`npm audit fix` (non-breaking only — no `--force`):

| | before | after |
|---|---|---|
| server, high + critical | 17 | 8 |
| client, high + critical | 8 | **0** |

Fixed, among others, **`proxy-addr` (critical, IP spoofing via IPv4-mapped IPv6 trust subnet)**,
which mattered here specifically: this server sets `trust proxy` and the login rate limiter keys
on the client IP, so a spoofable IP weakened the only brute-force control that exists until
Phase 1. Express went 4.21.2 → 4.22.2. Also cleared: `axios`, `body-parser`, `follow-redirects`,
`ip-address`, `nanoid`, `postcss`, `sharp`, `source-map-js`.

Still outstanding on the server, all needing a decision rather than a command:

| Package | Why it is still here |
|---|---|
| `zod` | needs 3 → 4, a breaking change across 19 schema files. The client is already on zod 4, so the versions have diverged. |
| `xlsx` | **no fixed version exists on npm.** SheetJS publishes to its own registry now. Either move to that, or replace it — `exceljs` is already a client dependency. |
| `qs`, `uuid` | transitive; worth a re-check after the zod and xlsx work shifts the tree |
| `vitest`, `tinypool`, `vite`, `prisma`, `@prisma/config`, `deepmerge-ts` | dev/toolchain only, not shipped |

**CI is now a real gate for the client.** `.github/workflows/security.yml` runs two audits per
workspace: production dependencies (`--omit=dev`), which **fails the build** for the client, and
a full advisory audit that only reports. The server's production gate stays advisory until `zod`
and `xlsx` are resolved; there is a `TODO` on the matrix entry to flip it.

## Tests

`npm test` in `server/` — **38 files, 377 tests, all passing.** 30 are new:

- `src/lib/mediaAccessToken.test.ts` (13) — window stability, acceptance of the previous window,
  rejection two windows on, the stated expiry being exactly right, future tokens, tampered and
  truncated tokens, and that rotating `JWT_SECRET` invalidates everything.
- `tests/mediaAuth.test.ts` (9) — integration, over HTTP. An anonymous read is 401 where it used
  to return a camera frame; an anonymous write is 401 where it used to accept a weight; a valid
  capability token on a **write** is 403 with a reason. Includes a repeated `?k=` that Express
  parses into an array, which must not be trusted.
- `src/lib/fileSignature.test.ts` (8) — every accepted format, RIFF-but-not-WebP, HTML/SVG/EXE/
  ELF/ZIP rejection, the polyglot case, and empty or truncated buffers.

`npm run typecheck` clean in both workspaces; `npm run build` in `client/` succeeds, which also
confirms the `api.ts` ↔ `mediaToken.ts` import cycle is genuinely gone rather than merely
type-checking.

## Left open

| Item | Where |
|---|---|
| Flip the CSP from Report-Only to enforcing | after a console check on the deployed app |
| Invoice files in a **public** Supabase bucket on never-expiring URLs (M2) | Phase 5 — it changes how URLs are stored and shared over WhatsApp and email, so it is not a drop-in |
| ClamAV hook for uploads | when there is somewhere to run it |
| Request bodies logged verbatim in two places (M6) | Phase 5 (log scrubber) |
| `zod` 3 → 4, `xlsx` replacement; then flip the server audit gate | its own change, with its own test pass |
| H3 (localStorage token, no revocation), H4 (flat authorization), H5 (no audit trail) | Phases 1, 2, 4 |

## A note on the Phase 0 audit

The scale endpoints were open in exactly the same way as the camera endpoints and were not in the
Phase 0 findings. The audit enumerated the CCTV routes in `index.ts` and stopped there, rather
than reading every app-level registration ahead of `requireAuth`. The lesson for Phase 2, which
has to get authorization right across ~393 routes: enumerate the route table mechanically, not by
reading the file and trusting that the interesting parts stand out.

---

## Correction after live verification

The deployed API was probed once Render finished building. Every gate holds:

| Check | Result |
|---|---|
| `GET /cctv/snapshot`, `/cctv/stream`, `/cctv/status`, anonymous | 401 (each returned data before) |
| `GET /scale/live`, `/scale/stream`, anonymous | 401 |
| `GET /weighbridge/snapshots/:filename`, anonymous | 401 |
| `GET /cctv/snapshot?k=junk` | 401 — an invalid token is no better than none |
| `GET /weighbridge/media-token`, anonymous | 401 — the only way to get a token needs a session |
| `POST /scale/config`, anonymous, empty body | 401. Probed with an empty body on purpose: had the gate failed, the handler would have answered 400 "Port name is required" without changing anything |
| `POST /scale/broadcast?k=junk` | 403 `A media access token cannot authorise this request; sign in instead` — the read/write split is live, and the handler never runs |
| `GET /scale/ports`, anonymous | 401 |
| Phase 6a: CORS for `www.rvpindustries.co.in` / a look-alike | ACAO echoed / absent — no regression |

**The mistake: the CSP went into the wrong file.** `vercel.json` at the repository root is **not**
the effective Vercel config — the project's root directory is `client/`, and `client/vercel.json`
exists with its own copy of the rewrites. The headers were added to the root file, so they were
inert: the deployed site returned none of them, only Vercel's own HSTS.

How it was caught, and how it was confirmed rather than guessed: the deployed `index.html`
referenced `assets/index-B3c3R7QW.js`, the exact hash the local build produced, so the client had
genuinely redeployed and a missing header could not be blamed on a build still running. The
rewrites were working at the same time (`/api/health` and a deep link both 200), which could only
come from `client/vercel.json`.

Fixed by moving the header block to `client/vercel.json` and restoring the root file to
rewrites-only. The headers are deliberately **not** duplicated across both files: two divergent
copies of the same config is what caused this, and the root file appears to be dead weight — if
anything, it should be deleted once someone confirms nothing else reads it.

The CSP is still Report-Only, so the flip to enforcing remains outstanding, and now it can
actually be checked: the header should appear on a response from `www.rvpindustries.co.in`.

**Lesson, worth carrying into Phase 2:** before changing deployment config, confirm which file
the platform actually reads. `ls` at the root is not that confirmation.
