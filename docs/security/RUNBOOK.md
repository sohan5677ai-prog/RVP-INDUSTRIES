# Runbook

What to do when something has gone wrong, written to be followed by someone tired and worried.
Every command here has been run at least once; nothing in it is aspirational.

Last exercised: **21 Nov 2026** (backup taken and verified).

---

## Backups

### Where they are

`C:\Users\SOHAN\OneDrive\RVP-Backups`, one file a night, named `rvp-<timestamp>.dump.enc`.
OneDrive syncs them off the machine. Retention is 30 days.

### The key

`BACKUP_ENCRYPTION_KEY` in `server/.env`. **Without it the backups are unreadable.**

> Keep a copy somewhere that is not this PC and not that OneDrive folder — a password manager, or
> written down at home. A key stored only beside the backups protects nothing, and a key lost with
> the machine loses the backups too.

### Take one now

```bash
cd server && node scripts/backup-database.mjs
```

Takes about a minute. It dumps through `DIRECT_URL` (port 5432) — **not** the pooled `DATABASE_URL`
on 6543, which cannot hold the session state `pg_dump` needs and produces a dump that fails at
restore.

It encrypts, then decrypts what it encrypted and compares, before writing anything. **Old backups
are only pruned after the new one is written and verified** — so a run of failures leaves you with
old backups rather than none.

### Register the nightly task (once, in an Administrator terminal)

```
schtasks /Create /TN "RVP Database Backup" /TR "C:\Users\SOHAN\Desktop\RVP-ERP\server\scripts\backup-nightly.cmd" /SC DAILY /ST 02:30 /RL HIGHEST
```

Check it afterwards:

```
schtasks /Query /TN "RVP Database Backup" /V /FO LIST
```

It appends to `%OneDrive%\RVP-Backups\backup.log`, so you can see whether it ran without opening
Task Scheduler.

Two things to know: **02:30 only fires if the PC is awake**, and a run takes about a minute. If the
machine is often off overnight, move the time to something during the working day - a backup that
runs at a dull hour beats one scheduled for an hour the PC is asleep.

The wrapper is a `.cmd` rather than a long `schtasks /TR` string, because quoting a cd-and-run
one-liner through Task Scheduler is the kind of thing that registers a task which silently never
works. It resolves its own directory from `%~dp0`, so the task does not depend on a working
directory.

### Check the config without taking one

```bash
cd server && node scripts/backup-database.mjs --check
```

---

## Restore

### Every month: verify (2 minutes, touches no database)

```bash
cd server && node scripts/restore-database.mjs --verify
```

Decrypts the newest backup and reads its table of contents. It proves the key still works, the file
is not corrupt, and the tables are there — it refuses if fewer than 50 tables carry data, which is
the quiet failure this catches. A healthy result today is **136 tables, 285 indexes**.

This is deliberately *not* a full restore. A procedure that needs a spare database and an hour is a
procedure that gets skipped until the day it is needed. Do this one monthly; do the full one below
when something changes.

### List what you have

```bash
cd server && node scripts/restore-database.mjs --list
```

### The real thing

```bash
cd server && node scripts/restore-database.mjs --into "postgresql://user:pass@host:5432/rvp_scratch" --confirm=host:5432
```

It **refuses** if `--into` resolves to the same host and database as `DATABASE_URL` or `DIRECT_URL`,
and requires `--confirm` to match the target host. Restore into a scratch database and promote it.
Do not restore over production in place: if the backup turns out to be bad you have then destroyed
the only copy of the thing you were trying to save.

---

## If the database is lost

1. **Stop writing.** Put the app in maintenance (Settings → Maintenance) so nothing lands in a
   database you are about to replace.
2. `node scripts/restore-database.mjs --list` — pick the newest backup from *before* the problem.
   If the problem was a bad migration at 14:00, last night's 03:40 backup is the one you want.
3. `--verify` it before relying on it.
4. Create a fresh Supabase database (or a local one) and restore into it with `--into`.
5. Point `DATABASE_URL` and `DIRECT_URL` at the restored database, redeploy.
6. Afterwards, run `node scripts/verify-audit-chain.mjs`. A restore from backup legitimately ends
   the chain at the backup's last row; that is expected, not tampering.

**What you lose:** everything since the last nightly backup, up to 24 hours. There is no
point-in-time recovery on the Supabase free plan.

---

## Audit trail

### Verify it

```bash
cd server && node scripts/verify-audit-chain.mjs     # exits non-zero on a break
```

### Reading a break

| What the report shows | What it means |
|---|---|
| Content hashes fail, **links intact, no gaps** | writer/verifier disagree — a bug, not tampering |
| **Links** break from one row onward | a row was altered or inserted; the chain points at where |
| A **gap** in `seq` | a row was deleted |
| Failures stop at a point in time, everything after verifies | whatever was wrong was fixed then — check what deployed |

### Repairing one

Only after reading the table above and understanding *why*.

```bash
cd server && node scripts/reseal-audit-rows.mjs            # dry run
cd server && node scripts/reseal-audit-rows.mjs --apply --confirm=reseal
```

It refuses if `seq` has a gap, because re-sealing would erase the evidence of a deletion.

---

## Storage

Pruned nightly at 03:40 IST by `storagePruneJob`. Sent WhatsApp documents are kept 7 days;
unreferenced files 48 hours.

```bash
cd server && node scripts/prune-storage.mjs                        # dry run
cd server && node scripts/prune-storage.mjs --apply --confirm=invoices
```

Switch it off with `STORAGE_PRUNE_ENABLED=false`.

The `invoices` bucket is **private**. Files are served only through `GET /api/files/:name` with a
signed, expiring token. A link that has expired returns 403 saying so — the fix is to reopen the
record in the app, which mints a fresh one.

---

## Offboarding a user

Settings → Users → the user → **Disable**.

That sets `disabledAt` **and revokes every live session and refresh token immediately** — not at
next idle timeout. The same happens on a role change, so a demotion cannot be used from an old
token.

To be thorough afterwards: check the audit trail for their last actions
(`/audit-trail`, filter by their name), and rotate any shared secret they knew
(`SLACK_*`, `GPS_PUSH_TOKEN`, the CCTV bridge key).

---

## Access review — every quarter, and whenever someone leaves

```bash
cd server && node scripts/access-review.mjs          # print it
cd server && node scripts/access-review.mjs --save   # keep a dated copy
```

Leads with findings rather than the table: privileged roles without two-factor, accounts that have
never logged in, dormant accounts, passwords over a year old, and disabled accounts that somehow
still hold a session (which should be impossible — disabling revokes them — so if it ever appears,
investigate rather than tidy).

The point is not the list, it is the questions it forces: does this person still work here, do they
still need that role, and why has nobody used that account since August?

## Secret scan

```bash
cd server && node scripts/scan-secrets.mjs            # all tracked files
cd server && node scripts/scan-secrets.mjs --staged   # pre-commit use
```

Deliberately narrow — PEM keys, JWTs and Supabase keys, AWS and Slack and Google keys, and
assignments to secret-ish names whose value is not a placeholder. It does **not** flag every long
hex string: hashes and cuids are full of them, and a scanner that cries wolf gets run with
`--no-verify`.

If it finds something real: **rotate it first**, then remove it. Deleting it from the working tree
is not enough — it stays in the history, so treat it as disclosed.

## Key rotation

| Secret | Where | Effect of rotating |
|---|---|---|
| `JWT_SECRET` | Render env | Signs access tokens, media tokens and **file links**. Rotating logs everyone out and invalidates every outstanding `/api/files` link. |
| `BACKUP_ENCRYPTION_KEY` | `server/.env` | **Old backups stay encrypted with the old key.** Keep the old key until those backups age out, or re-take one immediately after rotating. |
| `SUPABASE_SERVICE_ROLE_KEY` | Render env + `server/.env` | Full storage access. Rotate in Supabase, then update both. |

---

## Incident response

1. **Contain.** Disable the account involved (revokes sessions at once). Maintenance mode if the
   app itself is implicated.
2. **Preserve.** Take a backup *before* fixing anything — `node scripts/backup-database.mjs`. Do
   not prune storage or re-seal the audit chain until the picture is clear; both destroy evidence.
3. **Establish what happened.** `/audit-trail`, filtered by user or by record. "Show the whole
   request" turns the several rows one action wrote back into one event.
4. **CERT-In.** Reportable cyber incidents must be notified to CERT-In **within 6 hours** of
   noticing. Keep logs for 180 days. Incidents include unauthorised access to data and identity
   theft. <https://www.cert-in.org.in> — directions at
   <https://www.cert-in.org.in/Directions70B.jsp>.
5. **DPDP Act 2023.** A personal data breach must be notified to the Data Protection Board and to
   affected individuals. Party bank details, GSTINs and user emails are personal data.
6. Write it up in `docs/security/` afterwards, including what was *not* established.

---

## Health

| Endpoint | What it tells you |
|---|---|
| `GET /api/health` | the web process is up |
| `GET /api/health/db` | it can reach Postgres (awaits a real query) |

Render restarts the service on deploy, so a prune or a cron missing one night after a deploy is
normal.
