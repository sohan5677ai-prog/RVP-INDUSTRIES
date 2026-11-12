# Phase 3 — Master data controls

Branch: `security/phase-3-master-data` · Date: 2026-11-12

The fraud this phase exists to stop: someone changes a vendor's bank account, and the next
payment run sends money to them instead. Until now any account with `master.party.manage` could
do it in one request, and nothing recorded that it had happened.

Builds directly on the maker-checker framework from [Phase 2](PHASE-2.md), which shipped with
nothing routed through it. This is the workflow it was waiting for.

---

## What the plan asked for, and what exists here

| Plan item | Status |
|---|---|
| 3.1 Vendor bank changes through maker-checker, old details stay active | done |
| 3.2 Alert finance head and the vendor's registered email on approval | done, and also **on request** |
| 3.3 Penny-drop / name-match hook | interface only, as the plan specifies |
| 3.4 Same for company bank master, GSTIN | done |
| 3.4 Customer virtual-account mapping | **does not exist** — that is the Union Bank integration, Phase 7 |
| 3.4 PAN changes | **no PAN field exists** anywhere in the schema |
| 3.5 Field-level change history for all masters | done |

## The protected set, and one field that is not obvious

`lib/masterFields.ts` answers "what would someone change to divert a payment, and what would they
change first so nobody notices".

| Entity | Protected |
|---|---|
| Party | `bankAccountNumber`, `bankIfsc`, `bankName`, `gstin`, **`email`** |
| Company | `bankAccountName`, `bankAccountNumber`, `bankBranchIfsc`, `gstin` |
| Broker, Transport | nothing — they hold no bank details. They still get full history. |

**`email` is protected for a reason that is easy to miss.** It is where the alert about a bank
change is sent. Leaving it editable in one step means an attacker changes the email first and the
account second, and the warning arrives in their own inbox. Protecting the account without
protecting the address that reports on it protects nothing.

**Equally deliberate: name, address, phone and commodities are not protected.** They change often
and legitimately. Routing them through approval would teach everyone to approve without reading,
which is how a control stops working while still appearing to be there.

Where a batch mixes fields with different approval permissions, the **stricter** one wins — so
bundling a GSTIN change with a bank change cannot sneak the bank change through on the weaker
permission.

## The old details stay in force

`PendingChange` holds the proposed values; **nothing is written to the party**. That is the entire
point. If raising a request changed the record, an attacker would only need to raise one and wait
for the next payment run before anyone looked at the queue.

`prepareMasterUpdate` returns the subset of the incoming body that is safe to write, with the
protected fields stripped out. So a caller that ignored the rest of the result still could not
write a bank account — the safe thing happens even when the calling code is wrong.

The response tells the caller plainly that part of the edit is held, rather than echoing the old
value back and looking like a save that failed.

## Alerts, and where they go

Two audiences, two reasons, and the split is the point.

- **Internally**, to a new `securityAlertEmails` setting. Deliberately **not** `companyBccEmail`,
  which already receives a copy of every invoice and e-way bill — an alert in that stream is an
  alert nobody reads.
- **To the vendor**, at the address **currently on file**, never the proposed one. If the change
  is an email change, writing to the new address tells the attacker and leaves the vendor none
  the wiser.

Sent **on request as well as on approval**. The plan asks only for approval; telling people when
one is raised is what gives them a chance to stop it, and it reaches the vendor while their old
address is still on file.

Account numbers are masked to the last four in emails. An alert warning that an account changed
should not be the thing that carries the new number to an inbox. The **approval screen shows them
in full** — that is where someone decides whether the number is right, and they cannot do that
against four digits.

## Change history

`MasterChangeLog`: one row per field that actually changed, with before, after, who, when and
from which IP. Not a snapshot of the record — "what changed and who changed it" is the question,
and a diff of two JSON blobs is a worse answer than a list of fields.

Writing history never fails the edit that produced it, but it does log loudly: a silent gap in an
audit trail is worse than a noisy one.

`diffFields` treats null, undefined and empty string as the same value, because a form posting
`""` for an untouched optional field would otherwise read as a change from null — and a history
full of phantom edits is one nobody reads.

## Bank verification (3.3) — interface only

`lib/bankVerification.ts` defines the provider interface and nothing else, which is the scope the
plan sets. Adding a penny-drop provider later is then configuration, not a redesign of the
approval flow.

One deliberate detail: `UNAVAILABLE` is a distinct outcome from `MISMATCH`. An approver must be
able to tell "we could not check" from "we checked and the name is wrong". Collapsing them would
either block every approval during a provider outage or train people to ignore the warning. With
no provider configured it returns `UNAVAILABLE` and never blocks, so the flow is unchanged until
one is installed.

## Tests

`npm test` in `server/` — **48 files, 520 tests.** 17 new in `src/lib/masterFields.test.ts`,
covering the protected set (including that `email` is in it and `name`/`phone` are not), the
null/empty equivalence, a real clearing of a value, the stricter-permission rule for mixed
batches, and the masking.

The route coverage test caught the new `/master-history` endpoint immediately, and the FY archive
registry test caught `MasterChangeLog` needing classification — the fourth time that test has
done this across the phases. It is `EXCLUDED`: it spans years, so archiving one financial year
must not carry a party's history away with it, and it holds every previous bank account number.

## Rolling it out

1. **Apply the schema** — additive only, at `server/prisma/sql/phase-3-master-data.sql`.
2. **Set `securityAlertEmails`** in the company profile before relying on alerts. With it unset,
   changes are still held for approval and still recorded; only the internal email is skipped,
   and that is logged as a warning.
3. **Tell whoever maintains parties** that bank, GSTIN and email edits now wait for a second
   person. They will see it in the response; this should not be a surprise discovered mid-task.
4. There is no flag to turn this off. Unlike the CSP, MFA and RBAC rollouts, this one changes a
   workflow rather than tightening a check, and a half-enabled approval step is worse than none.

## Left open

| Item | Where |
|---|---|
| A penny-drop provider behind the hook | when one is chosen |
| Approval limits applied to master changes (the framework supports it; no amounts are attached) | when a rupee threshold makes sense for a master change |
| History UI on the party page itself — the endpoint exists, the Approvals screen does not surface it | a small follow-up |
| `master.party.bank.edit` still gates the whole party route rather than the field | the field-level gate is now the protected set; the route permission is the coarse outer gate |
