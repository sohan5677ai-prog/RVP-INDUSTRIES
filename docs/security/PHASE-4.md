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

**Scope note:** payments are converted. Receipts and set-offs have the columns and
`cancelDocument` supports them, but their delete endpoints are not yet converted — see Left open.

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

`npm test` in `server/` — **57 files, 645 tests.** 42 new. The chain tests name each tampering
scenario: edit in place, edit with the hash recomputed (the break then shows at the *next* row),
deletion from the middle, truncation from the end, insertion, and a chain not starting at
genesis. The period-lock tests pin inclusivity at both ends — a posting on the last day of a
closed month must be refused, not squeaked through by an off-by-one.

The FY archive registry test caught `AuditLog` and `PeriodLock` needing classification — the
**fifth** time across these phases. Both `EXCLUDED`: the audit log is a hash chain, so a slice of
it cannot be verified, and `PeriodLock` must stay put when a year is archived or archiving would
quietly unlock it.

## Deploying

1. **Two migrations are pending**, in order: the inbound-lorry columns from `c05474b`, then
   `server/prisma/sql/phase-4-audit.sql`. Both additive.
2. Audit capture starts the moment the server boots. There is no flag — a trail with an off
   switch is not a trail.
3. The first row writes with `prevHash` = 64 zeros. That is the genesis row, not a fault.
4. Run `POST /api/audit-log/verify` once after deploying, so there is a known-good baseline.
5. Consider the `REVOKE` above once the retention story is settled.

## Left open

| Item | Where |
|---|---|
| Audit viewer UI — the endpoint exists, there is no screen | a follow-up; the data is queryable now |
| Receipt and set-off deletes still hard-delete | same mechanism, not yet wired |
| Purchases, sales, credit/debit notes, loans | the larger half of "financial documents" |
| 4.6 retention job — the setting exists, nothing prunes | needs the `REVOKE` decision first, since pruning breaks the chain |
| Period lock has no UI | `/api/period-locks` works; a Settings screen would help |
