# Phase 8 — Monitoring and alerts

Branch: `security/phase-8-monitoring` · Date: 2026-11-27

---

## Why this phase, in one paragraph

Three times in this project something was quietly wrong and was found only because somebody went
looking: the storage bucket filling past its quota, the audit chain broken for two days, and the
nightly backup not running for a week. None of them was hard to detect. **Nothing was looking.**

This is what looks.

## What the plan asked for, and what was buildable

| Plan rule | State |
|---|---|
| N failed logins for a user/IP | **Built** |
| Login at odd hours | **Built** |
| Login from new country/IP | Partly — `sendNewDeviceAlert` already does new-device (Phase 1). Country needs a geo-IP lookup; not worth an external dependency for one rule |
| Role/permission changes, new admin user | **Built** |
| Vendor bank detail change | Already existed — `sendMasterChangeAlert` (Phase 3) |
| Large exports | **Built** on the `data.bulk_read` rows from Phase 5 |
| Audit hash-chain verification failure | **Built** |
| Bank API failures, certificate expiry, unmatched statement debit | **Blocked** on Phase 7, which is blocked on the UBI API document |
| Security dashboard page | **Built** — `/security` |
| *(not in the plan)* No recent backup | **Built**, because it is the failure that actually happened |

## Design decisions

### "Configurable rules" means thresholds, not a rule builder

A DSL is a great deal of surface for something one person will ever configure, and it is the
thresholds that actually need tuning — as the 500-row bulk-read default proved by filling 19% of
the audit trail. Thresholds come from the environment with sane defaults.

The large-export threshold is **1,000** rather than 500, so the two ordinary pages that routinely
return ~542 and ~675 rows stay out of it. They already fill a fifth of the audit trail; they must
not now fill this page too.

### Alerts are stored, not just emailed

`securityAlertEmails` has been unset for months. An email-only engine would have shipped and
alerted nobody — the same shape of failure this phase exists to end. An alert is a row, the page
shows it whatever the mail configuration does, and **the page says so when email is unconfigured**
rather than letting that stay invisible.

### One open alert per rule and subject

A repeat bumps `occurrences` and `lastSeenAt` instead of adding a row, and **only a new alert is
audited**. A check running hourly would otherwise produce twenty-four rows a day about one
problem, which is how the audit trail became 61% restart noise and then 19% bulk-read entries.
"×47 since Tuesday" says more than forty-seven identical rows anyway.

### State rules clear themselves; event rules do not

A chain that verifies again, or a backup that runs again, closes its own alert — a page of problems
that were fixed last week is a page nobody reads. A failed-login burst does **not** auto-close: the
event happened, and a person should see it before it disappears.

### Failed logins are counted per user *and* per IP

They are different attacks: one account under a dictionary, versus one address working through a
list of accounts. A rule counting only per user would miss the second entirely.

## The rules are pure functions

`securityRules.ts` takes the signals it needs and returns the alerts it wants raised — no database,
no clock of its own, no email. A monitoring system does not fail by crashing; it fails by being
quietly wrong, firing on nothing until people stop reading it or staying silent through the thing
it was built for. **The test that matters most asserts it says nothing at all on a healthy
system.**

## The backup check needed a bridge

The backup runs on an office PC and writes to OneDrive. The monitor runs on Render and cannot see
that folder, so a backup leaving no trace in the database is one this alert could never observe —
which is precisely the blind spot that let it stop for a week.

`backupHeartbeat.service.ts` writes a `backup.taken` row into the audit trail when a backup
succeeds, chained by hand under the same rules as `recordAudit` (lock the tail, take the next
`seq`, hash over the previous row). The chain still verifies afterwards.

## The chain heartbeat

The page distinguishes "verified and fine" from "never checked", so the monitor has to leave a
record. Not every run: hourly would add 8,760 rows a year to the trail this is meant to keep
readable. **Once every twelve hours**, and immediately on a failure — that one is evidence rather
than a heartbeat.

## Exercised against production

| | Result |
|---|---|
| First run | raised `backup.missing` (CRITICAL) — correctly, no heartbeat existed yet |
| Backup taken | `backup.taken` recorded at seq 1621 |
| Second run | cleared it automatically: `raised 0, cleared 1` |
| Chain afterwards | `intact, 1622 rows verified` — including the hand-written heartbeat |
| Overview endpoint | returns the real backup file, the last prune summary, thresholds, and `alertEmailConfigured: false` |

## Tests

`npm test` in `server/` — **83 files, 951 tests.**

## Also fixed here

`VoidInvoiceNumber` was added on 21 Nov in `06e1a11` and never classified for the FY archive, so
the archive registry test had been failing on `main` since. Classified **EXCLUDED**: carrying it
into an archive would free cancelled invoice numbers for reuse, which is the one thing the record
exists to prevent — the same reasoning as `PeriodLock`.

## Left open

| Item | Where |
|---|---|
| `securityAlertEmails` is still unset | So alerts are page-only. The page now says so instead of hiding it |
| Bank-related rules | Phase 7, blocked on the UBI API document |
| Login from a new country | Needs geo-IP; new-*device* alerting already exists from Phase 1 |
| The page has not been rendered against a signed-in session | It typechecks, builds its own chunk, and the endpoints return real data |
