# Phase 4 — Audit trail

Branch: `security/phase-4-audit` · Date: 2026-11-18

Fixes **H5**, the last of the five HIGH findings from the [Phase 0 audit](PHASE-0.md): there was
no audit log at all. No way to answer "who changed this vendor's account number", and no way to
tell that a payment row had ever existed.

---

## Decisions taken before writing code

| Question | Choice | Why |
|---|---|---|
| How writes are captured | **Prisma extension, automatic** | A call site that must be remembered is one a future endpoint forgets — exactly how the anonymous scale endpoints survived Phase 0 |
| Scope of "no hard delete" | **Financial documents** | Pool-report rows and notes are not the books; freezing them would clutter every screen with cancelled noise |
| Append-only enforcement | **Hash chain now, grants documented** | Role configuration is easy to get wrong remotely, and the retention work in 4.6 needs a path that can delete |

## 4.1 / 4.2 Capture

`lib/auditExtension.ts` hooks every `create`, `update`, `upsert` and `delete` at the database
client. A table written by code nobody has reviewed yet is still audited, and **an unknown model
is audited by default** rather than silently escaping.

Deliberately excluded:

- **The audit log itself** — infinite recursion.
- **Tables that already are a security record** — `LoginAttempt`, `PermissionDenial`,
  `MasterChangeLog`. Auditing them would double every entry they exist to hold.
- **High-volume machine telemetry** — `VehiclePing`, `WhatsAppLog`, `PrintJob`, `UserSession`. A
  GPS ping every 30 seconds per lorry would bury the human actions the trail exists to show.

The cost is one extra read on single-row updates and deletes, to capture the before-state. That
is the price of being able to say what a value *was*, which is the question an auditor asks.

### Knowing who did it

The extension sees the query but has no idea which HTTP request caused it. Threading an actor
through every service signature would be hundreds of call sites and one forgotten parameter away
from an anonymous audit row, so `lib/requestContext.ts` carries it in `AsyncLocalStorage`, set
once per request.

The auth middleware fills in the user on **all three paths**, including the one served from the
30-second `lastSeen` cache — without that, most requests would have audited as anonymous.

The request id is returned as `X-Request-Id`, so a user reporting a problem can quote one id that
finds every row for that action. Writes with no request — cron, boot, scripts — record a
**source** rather than being attributed to whoever happened to be signed in.

### Redaction

Password hashes, TOTP secrets and refresh-token hashes are stripped **by field name across every
model**, so a new table with a `password` column is covered the day it is added. An audit trail
that records credentials has turned itself into a second credential store — and one that, by
design, is never deleted.

## 4.3 Tamper-evidence

Each row hashes its own fields together with the previous row's hash, so altering or removing any
row breaks every hash after it.

**What this does and does not give you**, because an auditor will ask:

- It **detects** tampering, including deletion, after the fact.
- It does **not prevent** it. Anyone who can write to the table can recompute the chain.
  Prevention is the `REVOKE` below, and the chain is what catches a superuser who edits rows
  without bothering to rebuild it.
- It is **not a signature**. There is no secret involved, so it proves internal consistency, not
  authorship. Keyed hashing would tie the chain to the server's secret — and rotating
  `JWT_SECRET` would then invalidate the entire history, which is a worse trade here.

### The bug the live run found, and what it changed

Deployed, `node scripts/verify-audit-chain.mjs` against production reported **30 of 40 rows
altered** — with every link intact and no gaps. That shape is the tell: real tampering breaks
links, so a content-only failure is the writer and the verifier disagreeing.

The writer hashed the values **as Prisma handed them over** and stored the **redacted** copy. For
any row carrying a `Decimal` those are not the same thing:

```
Decimal(0) canonicalises to {"constructor":undefined,"d":[0],"e":0,"s":1}
the JSON column gives back   0
```

So every audited write touching money or a weight — `Account.openingBalance`,
`SubscriptionPlanConfig.amount` — was unverifiable from the moment it was written. The ten rows
that passed were the ones whose payload happened to be all strings.

The fix is **structural, not another type in the list**: every hashed field is computed once and
the same value is both hashed and written, so no in-memory/stored divergence is possible for a
type nobody has thought of yet. `redact` now also returns plain `null` rather than
`Prisma.JsonNull`, which is an object that would have hashed differently from the SQL null it
becomes, and keeps a Decimal as a **string** so a paise-level value survives exactly instead of
going through a float.

A second, latent instance of the same mistake went with it: `userId` was hashed from
`context.userId` but stored as `onBehalfOf?.userId ?? userId`, so every Slack-bot and kata-cabin
write would have failed verification too. Nothing had exercised that path yet.

**Why the tests did not catch it.** They hashed a row and verified it against the same in-memory
object, which is the one comparison that cannot fail.

Two tests now cover it, because one is not enough. `auditRedact.test.ts` pins the round-trip
invariant — hash `redact(values)` and `JSON.parse(JSON.stringify(redact(values)))` and require
they agree — which covers Decimal, Date, bigint and whatever is added next rather than the types
someone remembered. But a round-trip test **cannot** catch the redaction or `userId` variants,
because those are not round-trip failures: the hashed value and the stored value are simply
different values. So `recordAudit.test.ts` asserts it where the bug actually lived — it takes the
row `recordAudit` wrote, re-hashes it from its own stored columns exactly as the production
verifier does, and requires that to equal the hash written beside them. A row that passes there
cannot report as tampered in production.

Both were checked against the pre-fix writer: **11 of the 20 fail**, including the credential and
on-behalf-of cases. A regression test that passes on the broken code is decoration.

The lesson generalises past this phase: a tamper-evidence mechanism that cries wolf is worse than
none, because it teaches people to ignore it. It is only worth anything if it has been run against
real data — which is why it was run.

### Reading a break, for whoever reads the next one

The shape of the failures said what kind of problem it was before any code was opened, and it is
worth writing down:

| What the report shows | What it means |
|---|---|
| Content hashes fail, **links all intact, no gaps** | the writer and the verifier disagree — a bug, not tampering |
| **Links** break from one row onward | a row was altered or inserted; the chain points at where |
| A **gap** in `seq` | a row was deleted |
| Failures stop at a point in time and everything after verifies | whatever was wrong was fixed then — check what deployed |

That last row is how the fix was confirmed: every failing row predates the corrected code reaching
the server that wrote it, and all 8 rows after the last failure verify.

Two details the tests forced out:

1. **Object keys are sorted before hashing.** `{a:1,b:2}` and `{b:2,a:1}` are the same fact, and
   `JSON.stringify` would hash them differently by insertion order — the chain would then fail
   verification for no reason at all.
2. **The sequence is checked as well as the links.** Truncating the tail of the table leaves
   every remaining link valid; only a gap in `seq` reveals it. A chain alone would miss the
   easiest deletion of all.

Verification continues from what each row *claims* rather than what it should have been, so one
altered row reports one failure instead of cascading a false break through everything after. It
reports every failure, not the first: one break is one story, a hundred is another.

Two ways to run it: `POST /api/audit-log/verify` (which is itself audited — the evidence that
someone looked, and when), and `node scripts/verify-audit-chain.mjs`, which exits non-zero on a
break. The script is deliberately standalone JavaScript that does not import the server's
TypeScript: a verifier that needs the application to build cannot be run when the application is
broken, which is exactly when someone will want it.

### Making it append-only — run this yourself

```sql
-- Supabase SQL editor, as the project owner.
-- Replace <app_role> with the role in DATABASE_URL.
REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog" FROM <app_role>;
```

What it breaks: the retention work in 4.6 cannot prune rows afterwards without a privileged path,
and neither can anything else. That is the point, but it is a decision to take knowingly rather
than one for a migration to make on your behalf.

## 4.4 Cancel, not delete

The old `deletePayment` deleted the **journal entry**, which took the payment with it and left
nothing to show that money had ever been recorded as moving.

Now a payment is **cancelled**: the row stays with `cancelledAt`, who cancelled it and why, and a
**reversing journal entry** is posted so the ledger nets to zero.

Why a reversal rather than simply excluding the original from totals: the ledger is what
reconciles against the bank and against Tally, and an entry that silently stops counting is a
discrepancy nobody can trace. The reversal is dated **when the decision was taken**, not
backdated — which is also why cancelling into a closed period is refused on the way through.

Debits and credits are swapped line for line, **not negated**. A negative debit balances
arithmetically and is wrong in every report that groups by sign.

### The part that had to be got right

A cancelled payment must not count towards what a supplier has been paid. The dues pages sum the
payment list **client-side**, so leaving cancelled rows in would overstate payment and understate
dues — real money, wrongly stated. Every bulk read of payments and receipts now excludes
cancelled rows:

| Where | Why it matters |
|---|---|
| Payment and receipt lists | the dues pages sum these |
| `purchaseDues.service` | supplier dues arithmetic |
| `brokerLedger.service` | broker balances |
| party ledger (payments **and** receipts) | statements |
| set-off sizing | how much can be knocked off |
| dashboard shortage, TDS report | a cancelled receipt's TDS was reversed too, so it must not reach a statutory return |

`?includeCancelled=true` on the registers, where seeing what was withdrawn is the point.

### Receipts and set-offs

A receipt is not just its own posting. "Mark Paid" writes separate `TDS-<dispatchId>` and
`SHORTAGE-<dispatchId>` entries that are **not children of the receipt's journal entry**, and the
old delete removed them too. Cancelling has to reverse them as well, or the receipt would be
withdrawn while its TDS stayed in the ledger and on a statutory return — so
`reverseByReference` reverses every entry posted under a reference, and it runs in the **same
transaction** as the cancellation. Doing them in two transactions would leave a window where the
TDS had been withdrawn but the receipt still looked live.

A set-off is cancelled together with both its Payment and Receipt legs. Only the set-off's own
entry is reversed: the legs carry no separate posting, so reversing them would double the contra.

**Still hard-deleting:** purchases, sales, credit and debit notes, loans — see Left open.

## 4.7 The viewer

`/audit-trail`, its own page rather than a Settings tab: this is where someone goes to answer "who
changed this, and when", which is a task, not a setting.

Three things on one screen, because they are one question:

- **Verify chain** runs `POST /audit-log/verify` and says plainly what a break means — "not a
  glitch to retry". A green tick nobody understands is worth nothing.
- **Closed periods**, including the ones that were **reopened**. Those stay on screen rather than
  being tidied away once released: that a closed period was reopened, by whom and why, is exactly
  what an auditor asks about.
- **The log**, newest first, each entry opening to show only the fields that actually **differ**.
  A dump of every column makes the reader find the change; a diff tells them.

Two details worth naming:

1. **Cursor-paged, not offset-paged** — the table only ever grows, so an offset page would shift
   under the reader as new rows arrive while they read. "Load older" walks `seq` backwards.
2. **"Show the whole request"** filters by `requestId`. One action that touched four tables was
   written as four rows; this is what turns them back into one event.

The page hides the period-lock form from anyone who is not ADMIN or DEVELOPER, and the nav link
from a USER. That is **not** the permission check — `/audit-log` is behind `audit.view` and writing
a lock behind `system.manage`, both on the server. Hiding the control only avoids offering a button
that is certain to come back 403.

## 4.5 Period lock

Enforced in `LedgerService.postJournalEntry`, which is the **only** place in the codebase that
writes a journal entry. That is the right boundary by definition: a period lock is a statement
about the books, and every posting — payment, receipt, purchase, sale, set-off, loan — passes
through that one function. Guarding the document tables instead would mean keeping a list, and
the list would go stale the first time a new document type was added.

A lock is a **date range**, so a year closes in one row and a partial close ("up to the 15th,
pending a reconciliation") needs no second concept.

The lookup **fails closed** on a database error, unlike the permission lookup which falls back to
defaults. The asymmetry is deliberate: being unable to read the permission table should not lock
the company out of their ERP, but being unable to read the lock table must not let a posting into
a closed year — that is a number in a filed return. The error says so, so the operator retries
rather than assuming the period is open.

Reopening updates the row rather than deleting it, so the fact that a closed period was reopened
— by whom, when and why — survives. A reason is required.

## Tests

`npm test` in `server/` — **60 files, 680 tests.** 77 new. The chain tests name each tampering
scenario: edit in place, edit with the hash recomputed (the break then shows at the *next* row),
deletion from the middle, truncation from the end, insertion, and a chain not starting at
genesis. The period-lock tests pin inclusivity at both ends — a posting on the last day of a
closed month must be refused, not squeaked through by an off-by-one.

`reversal.test.ts` carries the assertion that matters most in this phase: that a reversal
**swaps** debits and credits rather than negating them. A negated line balances arithmetically, so
no total would ever look wrong — it would only be wrong in every report that groups by sign, which
is the kind of error found a year later during a reconciliation.

The FY archive registry test caught `AuditLog` and `PeriodLock` needing classification — the
**fifth** time across these phases. Both `EXCLUDED`: the audit log is a hash chain, so a slice of
it cannot be verified, and `PeriodLock` must stay put when a year is archived or archiving would
quietly unlock it.

## Cleaning up after the bug

The 38 rows written under the broken scheme could never verify, so they were dealt with
deliberately rather than left to report a break for ever — a verifier that is always red is one
nobody reads. `scripts/reseal-audit-chain.mjs` did it on 18 Nov:

- **36 deleted.** `account.update`, `transport.update` and `subscriptionPlanConfig.update` written
  by `system` on each restart. They record no human action, so nothing was lost.
- **2 kept and re-sealed.** The `user.update` rows, where a password and MFA secret changed. That
  is exactly what an audit trail is for; deleting them because *my own* code sealed them wrongly
  would have been the wrong trade.
- **119 re-linked.** Unavoidable: removing rows from the middle of a hash chain breaks every link
  after them, so pruning cannot be done without re-sealing the rest. `seq` was compacted back to
  1..N as well, because a permanent gap reports as a break for ever.

**What that costs, stated plainly:** after a prune, the gapless-`seq` property no longer evidences
those deletions. The `audit.prune` row at seq 122 and the backup under `server/backups/` are what
stand in for it. This is the same tension as the 4.6 retention job, met early and by accident.

The script stays in the tree as the record of what was done. It is deliberately awkward — dry-run
by default, `--apply` required, and four safety checks that abort rather than widen: every row it
deletes must be named in an explicit reviewable list, must carry one of three expected actions,
must have no `userId`, and **must already fail verification**. That last one matters most: it
cannot touch a row written after the fix. Re-running it now aborts on the first check.

Result: `audit chain intact: 122 rows verified`, exit 0.

## Deploying

1. **The schema is already applied** — `AuditLog`, `PeriodLock`, the `cancelledAt` columns on
   Payment / Receipt / PartySetOff and `JournalEntry.reversalOfId` are all live, checked against
   the database on 2026-11-18. Nothing is pending.
2. Audit capture starts the moment the server boots. There is no flag — a trail with an off
   switch is not a trail.
3. The first row writes with `prevHash` = 64 zeros. That is the genesis row, not a fault.
4. Run `POST /api/audit-log/verify` once after deploying, so there is a known-good baseline.
   **Do this every time** — it is what found the Decimal bug above, which no test could have.
   The 38 rows written before that fix could not verify under the corrected scheme; they were
   pruned and re-sealed on 18 Nov — see "Cleaning up after the bug".
5. Consider the `REVOKE` above once the retention story is settled.

## Left open

| Item | Where |
|---|---|
| Purchases, sales, credit/debit notes, loans still hard-delete | the larger half of "financial documents"; the mechanism is built and tested, each one needs its read paths guarded the way payments' were |
| 4.6 retention job — the setting exists, nothing prunes | needs the `REVOKE` decision first, since pruning breaks the chain |
| The viewer has not been rendered against a signed-in session | it typechecks and builds, and the endpoints it calls are tested; the screen itself wants one look |
| **61% of the trail is restart noise** | 75 of the 122 remaining rows are `account.update`, `transport.update` and `subscriptionPlanConfig.update` — the same six records rewritten on every server boot, recording no human action. Something at startup writes identical values back. At six rows a restart this will bury the human actions the trail exists to show, so either make those writes conditional or exclude boot-time writes from capture |
