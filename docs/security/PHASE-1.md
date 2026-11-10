# Phase 1 — Login and identity

Branch: `security/phase-1-identity` · Date: 2026-11-10

Fixes **H3** from the [Phase 0 audit](PHASE-0.md): a 7-day token in `localStorage` that nothing
revoked, 6-character passwords, bcrypt at cost 10, no MFA, and no lockout.

> **This phase is not deployable on its own.** The schema has not been applied, and the
> client/server login contract changed in the same breath — see **Deploying** at the end.

---

## Decisions taken before writing any code

| Question | Choice | Why |
|---|---|---|
| Argon2id or bcrypt cost ≥12 | **Argon2id** via `@node-rs/argon2` | Prebuilt binaries, no node-gyp; `bcryptjs` is pure JS and cost 12 would burn ~0.5–1s of server CPU per attempt. Native deps are proven here already (`sharp`, `serialport`). |
| Cookies or token pair | **Short-lived access + rotating refresh** | The Slack bot, Tally agent, CCTV bridge, print agent and kata cabin all authenticate with headers. Cookies would have meant special-casing five non-browser clients and adding CSRF protection to every state-changing route. |
| Reset/alert channel | **`email` column on `User`** | Resend is already wired and verified. The alternatives were recovery-codes-only (leaves 1.6 and 1.8 unimplemented) or WhatsApp (template needs Meta approval first). |

## What each item does

### 1.1 Hashing — argon2id, with a silent upgrade path

`lib/passwordHash.ts`. OWASP baseline (19 MiB, t=2, p=1), chosen over something heavier because
Render's starter instance has 512 MB and logins arrive together at shift change — `memoryCost` is
per concurrent hash.

Existing accounts hold bcryptjs hashes, so both formats verify and a bcrypt hash is rewritten as
argon2id on the owner's next successful login. Nobody is told to change their password.

Two details that matter more than they look:

- **The algorithm is decided by sniffing the stored hash**, not by the `passwordAlgo` column.
  Both formats are self-describing, so a stale column value cannot lock anyone out. The column
  defaults to `BCRYPT` because every row that existed when it was added held a bcrypt hash —
  defaulting it to `ARGON2ID`, as the first draft did, would have labelled all of them wrongly.
- **The dummy hash for unknown usernames is argon2 too.** The old code compared against a
  hardcoded bcrypt hash to keep timing constant. Left alone, a nonexistent username would now be
  measurably *faster* than a real one, reintroducing the enumeration leak that code existed to
  prevent.

A malformed stored hash is a failed verification, not a 500 — one corrupt row cannot take the
login endpoint down.

### 1.2 Password policy

`lib/passwordPolicy.ts`, `lib/commonPasswords.ts`. Minimum 12, a local blocklist, no reuse of the
last 5, and nothing derived from the account itself.

No character-class rules, deliberately. Forcing an uppercase, a digit and a symbol reliably
produces `Password@1`, which is in every breach corpus; NIST SP 800-63B dropped composition rules
in favour of length plus screening, and that is what this implements.

The blocklist is local rather than the Have I Been Pwned API: that would put an outbound request
on the critical path of every password change, and send a prefix of the user's password hash out
of the building. The list is short because comparison is against *normalised* forms — leet
substitution and tail-stripping — so one entry covers a family. `P@ssw0rd!!!!`, `password1234`
and `Adm1n1strat0r` are all caught by three entries.

History is checked by verifying the candidate against each stored hash, not by hashing and
comparing strings: the hashes are salted, so string comparison would never match.

### 1.3 MFA — TOTP with recovery codes

`lib/mfa.ts`. One-step drift window, and the matched time step is returned so a replay inside that
window can be refused — otherwise a code read off someone's screen stays usable for 90 seconds.

**Recovery codes rather than emailed OTPs**, which the plan offered as the fallback. An emailed
code makes the mailbox a second factor that is usually open in the same browser, and it depends on
Resend being up at the moment someone is locked out. Codes use an alphabet without `0/O`, `1/I/L`,
`2/Z`, `5/S`, `8/B`, so a code misread off paper under mill lighting cannot become a different
valid one. Stored hashed, shown exactly once.

**Required of ADMIN, OWNER and DEVELOPER.** The plan names finance, accounts and treasury, which
do not exist here; Phase 2 moves this onto permissions. `USER` is excluded deliberately —
shop-floor and cabin staff share devices and not all have smartphones, so enforcing it would
produce one phone kept in a drawer, which looks like control without being it.

**Enforcement is behind `MFA_ENFORCE`, default off.** Turning it on before the privileged accounts
have enrolled would lock every administrator out with no way back except a database edit. So it
ships inert: enrol, confirm it works, then set `MFA_ENFORCE=true`. Same approach as the
report-only CSP in Phase 6b, for the same reason.

### 1.4 Lockout

`lib/loginGuard.ts`. Five consecutive failures to a 15-minute lock, both configurable, plus a
per-**username** flood check across all IPs.

Per-username is the point. The existing `loginLimiter` caps attempts per IP, which credential
stuffing never trips because it spreads one username across many addresses. State lives in the
database rather than process memory: Render can run more than one instance, and an in-memory
counter resets on every deploy.

The lock is checked **before** the password is verified, so a locked account cannot be used as an
oracle to test passwords. The flood check fails open — a count query failing must not lock
everyone out of the ERP — while the lock itself, the password and MFA all fail closed.

**No captcha**, which plan item 1.4 asks for. It needs a third-party script, which fights the CSP
enforced in Phase 6b, and lockout plus per-username throttling addresses the same threat.

### 1.5 Sessions

`lib/tokens.ts`. 15-minute access token, opaque refresh token rotated on every use and stored only
as a SHA-256 hash, 12-hour absolute cap.

- **`pwdAt`** is carried in the access token and compared against `User.passwordChangedAt`. This
  is what makes a password change sign out every other device *immediately* rather than whenever
  the old tokens happen to expire. Compared with a second of slack, because Postgres keeps
  milliseconds and the JWT `iat` does not — without it, the token minted *by* a password change
  could be rejected by it.
- **Refresh reuse is treated as theft.** A refresh token that does not match the stored hash, on a
  session that has one, means an already-rotated token was replayed; the session is destroyed
  rather than re-issued.
- SHA-256 rather than a password hash for the refresh token: it is 256 bits of uniform
  randomness, so there is no dictionary to attack, and it runs on every refresh.
- Idle stays at **20 minutes**, not the plan's 15 — that is an established setting here and
  changing it is a UX decision, not a security one.

Sessions are now revoked on password change, role change, and disable. The middleware checks all
three, plus the absolute cap, on every request that misses the 30-second `lastSeen` cache.

### 1.6 / 1.8 New-device alerts and forgot-password

`services/securityMail.service.ts`. Plain text, because a security email should look like what it
is. Both are best-effort and never throw: a failed alert must not fail the login it reports on,
and a failed send must not become a 500 that reveals whether an address exists.

`/auth/forgot-password` answers **identically** whether or not the address is known, and the
client shows one confirmation either way. Tokens are hashed, single-use, 15 minutes. A successful
reset revokes *every* session — whoever asked for it may be locking an intruder out.

### 1.7 IP allow-list

`lib/ipAllowList.ts`. **Inert by construction**: a role with no rules is unrestricted, so
deploying it cannot lock anyone out and it only starts applying when someone adds a rule.

Handles the IPv4-mapped IPv6 form (`::ffff:203.0.113.4`) that Express reports behind Render's
proxy — an IPv4 rule would otherwise never match the office. IPv6 rules match literally rather
than pretending to do prefix maths. Fails open on a database error, for the same reason as the
flood check.

## Schema

Additive only. The generated SQL is at `server/prisma/sql/phase-1-identity.sql` and contains no
`DROP`, `TRUNCATE` or `DELETE`.

- `User` + `email`, `passwordAlgo`, `passwordChangedAt`, `mustChangePassword`, `mfaSecret`,
  `mfaEnabledAt`, `failedLoginCount`, `lockedUntil`, `lastLoginAt`, `disabledAt`
- `UserSession` + `refreshTokenHash`, `absoluteExpiresAt`, `trustedAt`
- New: `PasswordHistory`, `MfaRecoveryCode`, `PasswordResetToken`, `LoginAttempt`, `IpAllowRule`

`LoginAttempt` is also the first row of the audit trail Phase 4 builds out.

**The FY archive registry caught something worth recording.** Its test asserts every Prisma model
is classified, so the five new tables failed it until they were added as `EXCLUDED` — they are
credentials and security telemetry, not the client's books. Classifying them made it obvious that
`User` is exported as a master with `omit: ['password']`, and that **`mfaSecret` needed adding to
that list**: without it, a financial-year archive handed to a CA would contain a working second
factor for every enrolled account.

## Client

- **Transparent refresh.** A 401 now usually means a 15-minute token expired, so `api()` tries the
  refresh token once and retries before signing anyone out. Single-flight: a page firing six
  queries at once would otherwise send six refreshes, and since the server rotates on every use
  and treats a replay as theft, five would be rejected and the session killed.
- `apiBase.ts` holds `API_BASE` and token storage so `mediaToken.ts` and the refresh path can use
  them without an import cycle; `api.ts` re-exports everything, so existing imports are untouched.
- Login gains the two-factor step, "Remember this device" (which suppresses the new-device alert)
  and a forgot-password link.
- New pages: `/forgot-password`, `/reset-password`. New `PasswordChangeBoundary` blocks the app
  when `mustChangePassword` is set — which is whenever someone else chose the password.
- `PasswordFields` shows the policy live. It is a courtesy, not the policy: the server validates
  independently and is the only thing that decides.
- Admin user management gains email, a disable toggle, and MFA/lock/last-login columns — the
  makings of the quarterly access review in Phase 9.
- **Settings → Security** carries MFA enrolment, password change and sign-out-everywhere. The QR
  is rendered server-side as a data URL by the `qrcode` package already on the server: no new
  client dependency, and no CSP change, since `img-src data:` is already allowed. Enrolment is
  three steps — scan, verify, save recovery codes — because the account is not protected until a
  code has verified. Turning MFA off asks for the password *and* a code, and is refused outright
  for a role that requires it.

## Tests

`npm test` in `server/` — **44 files, 460 tests, all passing.** 83 new. `tsc --noEmit` clean in
both workspaces; `npm run build` passes in `client/`.

> Use `npm run build` rather than `npm run typecheck` as the client gate: build mode (`tsc -b`)
> caught a duplicate exported function that `tsc --noEmit` did not.

The tests earned their keep three times:

1. **`password1234` passed the blocklist.** De-leeting ran before tail-stripping, so `1234` became
   letters and could never be stripped — the blocklist never saw `password`. Both orders are now
   applied.
2. **`KumarKumarKumar` passed the personal-data check**, because it compared against the whole
   name `"sohan kumar"`. Names are now split into words; a surname alone is as guessable as the
   whole name.
3. **The archive registry failure** described above.

Verified in a real browser against the dev server: `/forgot-password` and `/reset-password`
render, the live policy checklist marks `password1234` as commonly used and keeps submit disabled,
a strong passphrase turns every rule green and enables it, and the login page shows the new
controls without disturbing the existing design.

## Deploying — read before shipping

This phase cannot be deployed piecemeal.

1. **Apply the schema first.** `prisma db push`, per the standing rule (never `migrate dev`).
   Nothing in the SQL is destructive, but it alters the live database and has not been run.
2. **Server and client must deploy together.** The login response shape changed, and access
   tokens dropped from 7 days to 15 minutes. An old client against the new server cannot read the
   response; a new client against the old server gets no refresh token.
3. **Everyone is signed out once.** Existing tokens carry no `pwdAt` and no session row with a
   refresh hash. This is unavoidable and worth announcing rather than discovering.
4. **Set an email on each account** that should be able to self-serve a reset. Until then those
   users need an admin to set their password.
5. **Leave `MFA_ENFORCE` unset.** Enrol the privileged accounts, confirm a sign-in works end to
   end, then set it to `true`.
6. Existing passwords shorter than 12 characters keep working — the policy applies when a password
   is *set*. Plan a rotation separately.

## Left open

| Item | Where |
|---|---|
| ~~MFA enrolment UI~~ | **done** — Settings → Security (`a5b48d3`) |
| Password expiry (plan 1.2, "optional expiry setting") | not built; the column to drive it (`passwordChangedAt`) exists |
| IP allow-list admin UI — rules must be inserted by hand today | Phase 2, alongside permissions |
| `zod` 3 → 4, `xlsx` replacement | carried from Phase 6b |
| H4 flat authorization, H5 no audit trail | Phases 2 and 4 |
