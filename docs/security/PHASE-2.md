# Phase 2 — Roles, permissions, segregation of duties

Branch: `security/phase-2-rbac` · Date: 2026-11-12

Fixes **H4** from the [Phase 0 audit](PHASE-0.md): authorization was effectively flat — any
signed-in account could delete a payment, void a purchase, or rewrite a party's bank details.

> **Ships in audit mode.** Permissions are evaluated and every would-be denial recorded, but
> nothing is blocked until `RBAC_ENFORCE=true`. See **Rolling it out**.

---

## First, the route table — measured, not read

The Phase 0 audit missed the anonymous scale endpoints because it read the route files and
trusted the gaps to stand out. With this many routes that does not work, so the first thing built
in this phase was `server/scripts/audit-routes.mjs`, which enumerates every route and the guards
in front of it.

```
Routes found: 415

  authenticated    340     signed in, but no authorization whatsoever
  explicit          57     a real role guard
  PUBLIC            15
  unknown            3

Writes (non-GET): 252
  of those, protected by nothing but "is signed in": 201
```

**201 write endpoints needed nothing more than a session.** That is H4 with a number against it.

All 18 unguarded routes were checked individually and every one is intentional: the 6 credential
endpoints, 2 health probes, the Razorpay webhook (HMAC), the maintenance banner, 4 webhooks
(Svix, Fast2SMS, cron secrets), the CCTV bridge push (bridge key, which the tool counts twice
because it is registered at both app and router level), and the 2 kata slips (timing-safe HMAC).

The tool found a false positive on its first run — it flagged three subscription routes as public
because it looked only for `router.use(requireRole)` and missed `router.use(requireAuth)`. It now
compares line numbers, because that file deliberately declares the Razorpay webhook *above* the
guard. A tool that cries wolf is as useless as one that misses things.

## Decisions taken before writing code

| Question | Choice | Why |
|---|---|---|
| Rollout | **Audit mode first** | 201 writes needed only a session; deny-by-default on day one would have stopped someone mid-shift over a single mis-mapped route |
| Role shape | **Keep the 4 roles, attach permissions** | Nothing changes about how people sign in on day one; roles can be split later once the map is proven |
| Maker-checker | **Framework only** | The machinery and the segregation rule, with no workflow behind it yet. Phase 3 applies it to vendor bank details, where the fraud risk actually is |

## How it works

### The catalogue — `lib/permissions.ts`

Permissions are defined in code, not the database, because each is tied to specific endpoints:
inventing one at runtime would grant nothing, and deleting one would silently open a route. What
*is* editable at runtime is which permissions a role holds.

Actions are deliberately few — `view`, `manage`, `delete`, `approve`, `export` — and the split
between **manage and delete** is the main reason this is not simply read/write. The audit found
44 hard-delete routes on financial documents, all reachable by any account.

Role defaults, and the reasoning worth defending:

- **USER keeps the day job and loses the irreversible half.** Still creates purchases, sales,
  payments and weighbridge tickets — that is the work. Loses `.delete` on financial documents,
  `master.party.bank.edit`, `payment.approve`, `report.export`, `pii.view`, and everything
  administrative.
- **A creator cannot approve.** `payment.approve` is withheld from USER so the segregation rule
  has something to bite on.
- **OWNER sees everything and signs off, but does not administer.** No `user.manage`,
  `role.manage` or `system.manage` — owning the business is not the same job as running the
  deployment, and conflating them is how an audit trail stops meaning anything.
- **DEVELOPER keeps everything**, because it is the account that fixes the deployment when it is
  broken.

### The map — `lib/routePermissions.ts`

One ordered table, first match wins, rather than `requirePermission(...)` sprinkled across 35
route files. Three reasons:

1. A reviewer or auditor can read the entire authorization model on one screen.
2. A route added without a rule is caught by a test, instead of silently inheriting whatever its
   neighbours happen to have.
3. **It required no edit to any route file**, so this phase cannot have broken a route by
   fumbling middleware order — a real risk when touching 415 of them.

Two star forms, because the difference matters: `/brokers*` is the collection *and* everything
under it, while `/brokers/*` is only things under it. That is what lets `DELETE /parties/*` mean
`master.party.delete` without also claiming a hypothetical `DELETE /parties`.

`permission: null` means "any authenticated user", used only for `/auth/*` — the caller acting on
their own account. Gating those would let a misconfigured role lock someone out of changing their
own password.

### Enforcement — `middleware/routePermission.ts`

Mounted once, just after `requireAuth`. An unmatched route is **denied when enforcing** (deny by
default, plan item 6.7); the coverage test means that can never be a surprise.

Grants resolve from `RolePermission` when rows exist for a role, otherwise from the code
defaults. Deliberately all-or-nothing per role rather than an allow/deny overlay: an overlay
reads simply until a default changes in a release and silently shifts what a customised role can
do.

The lookup **fails to the code defaults, not to an empty set**. Failing closed there would lock
the whole company out of their ERP because a settings table was briefly unreachable —
authentication, which does fail closed, has already run by that point. The fallback is cached
briefly too: without that, a missing table means a failing query on *every* request across 415
routes, which is exactly the state between deploying this code and applying the schema.

## Tests

`npm test` in `server/` — **46 files, 485 tests.** The two that carry this phase:

- **`tests/routePermissionCoverage.test.ts`** runs the audit script and cross-checks every route
  against the table. A route added without a rule fails CI rather than failing a user. It also
  pins the public list, so a *new* public route fails the build instead of joining the list
  unnoticed, and asserts the table names only permissions that exist.
- **`tests/routePermissionEnforcement.test.ts`** drives the middleware over HTTP with Prisma
  mocked. The central pair: audit mode lets a `DELETE /payments/:id` through from a USER *and*
  records the denial with `enforced: false`; enforcing mode returns 403. Getting that backwards
  would either block the company on deploy or quietly do nothing while appearing to protect
  things. It also covers stored grants overriding defaults, bogus permission strings being
  ignored, and the database-error fallback still refusing `payment.delete`.

Two bugs the tests caught in this phase's own code:

1. **Every `DELETE` rule silently failed to match.** Stripping `*` from `/payments/*` left a
   trailing slash, which became an empty path segment and compiled to a regex matching only
   `/payments/`. Caught by the coverage test, not by reading.
2. **`/subscription-plans` had no rule** — it lives in `poolReport.routes.ts` and is the
   recurring-expense config, not the licensing subscription. Worth noting that `/subscription*`
   correctly did *not* swallow it.

And once again the FY archive registry test caught the two new models needing classification;
both are `EXCLUDED` — `RolePermission` describes exactly where the access-control boundaries are,
and `PermissionDenial` is security telemetry with its own retention.

## Schema

Additive only: `RolePermission` and `PermissionDenial`. SQL at
`server/prisma/sql/phase-2-rbac.sql`.

## Rolling it out

1. **Apply the schema** (`prisma db push`). The code works without it — the lookup falls back to
   defaults — but every request logs a failed query until it is applied.
2. **Deploy with `RBAC_ENFORCE` unset.** Nothing is blocked; denials accumulate in
   `PermissionDenial` with `enforced = false`.
3. **Run a normal week.** Month-end matters here: a permission only exercised at closing will not
   appear in three days of data.
4. **Read the log**, grouped by permission and user:
   ```sql
   SELECT role, permission, method, path, count(*)
   FROM "PermissionDenial" WHERE enforced = false
   GROUP BY 1,2,3,4 ORDER BY 5 DESC;
   ```
   Each row is either a permission someone legitimately needs — grant it to the role — or exactly
   the hole this phase exists to close.
5. **Set `RBAC_ENFORCE=true`** once the log is quiet for a full cycle.

Rolling back is one environment variable, not a deploy.

## Object-level ownership (2.3) — and a real IDOR

The plan frames 2.3 as cross-company IDOR. This is single-company, so there is no tenant boundary
to cross; what genuinely is per-user is small and specific. Looking there found a live bug:

**All four per-id user-note handlers checked only that the note existed, never that it belonged to
the caller.** `GET /user-notes/:id` did not even check `req.user`. Any signed-in account could
read, edit, complete or delete another person's notes by knowing an id.

Fixed with `lib/ownership.ts`, which answers **404, not 403**: telling someone "that exists but is
not yours" confirms the id is real, which is information they should not have about another
person's note.

`SupportTicket` was already scoped correctly, including its deliberate privileged-sees-everything
path for developers reading tickets they did not raise.

## Maker-checker (2.4, 2.5, 2.6)

The framework, with nothing routed through it — Phase 3 attaches vendor bank details, which is
where the fraud this exists to stop actually happens. Shipping the machinery first means that
phase registers an applier rather than inventing a workflow under time pressure.

`PendingChange` holds the proposed values as JSON rather than writing them to the target row, so
the current details stay in force until approval. That is the entire point for a bank account: the
old account keeps being paid until someone else agrees to the new one.

Two rules live in the service rather than in each caller, because a rule every caller must
remember is one some caller will forget:

1. **The requester cannot decide** — not with the permission, not as DEVELOPER. A segregation rule
   the most privileged account can step around protects nothing, since that is the account an
   attacker wants anyway.
2. **The approver needs the permission the request recorded**, not today's — so changing the route
   map later cannot lower the bar for requests already in flight.

Approval limits (2.5) are inert until configured, like the IP allow-list. But where the permission
lookup falls back to the code defaults on a database error, the limit lookup falls back to
**zero**: returning "no limit" there would let an unreachable database quietly raise someone's
ceiling.

Approval and application are separate states. If applying throws, the row lands in `FAILED` with
the error rather than staying `PENDING` (inviting a second approval of something half-done) or
showing `APPLIED` (which would be a lie). The claim is a conditional `updateMany`, so two approvers
clicking at once cannot both apply it.

## Admin UI

**Settings → Roles & Access**, for ADMIN and DEVELOPER — not OWNER, matching who holds
`role.manage`. The permission matrix and the denial log sit on one screen deliberately: the log
says what a role is missing and the matrix is where you grant it, and splitting them would mean
reading one tab and acting in another from memory. The banner states plainly whether enforcement
is on, because editing grants in audit mode otherwise implies a protection that is not yet there.

Two guards on the editing itself: the DEVELOPER role cannot be edited from inside the app, and
ADMIN cannot drop `role.manage` — either would leave no way back.

There is no pending-changes screen yet. With no workflow routed through the framework it would
always be empty; it arrives in Phase 3 with the first one.

## Left open in this phase

| Item | Where |
|---|---|
| `master.party.bank.edit` enforced on the field, not just the route | Phase 3, where bank changes get maker-checker |
| `report.export` and `pii.view` actually gating exports and masked fields | Phase 5 |
| `audit.view` has nothing to read yet | Phase 4 builds the log |
