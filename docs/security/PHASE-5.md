# Phase 5 — Data protection

Branch: `security/phase-5-data-protection` · Date: 2026-11-18

---

## What the plan asked for, and what this codebase actually needed

Three of the six items did not fit as written. That is worth recording in full, because the
mismatch is the useful part — the plan was drafted against a generic Indian ERP, not this one.

| Plan item | Reality |
|---|---|
| 1. HTTPS, HSTS, TLS 1.2+, redirect | **Already done.** No code change — see below |
| 2. Encrypt bank accounts, Aadhaar, PAN | **No Aadhaar or PAN column exists.** Reduces to one field; deferred by decision |
| 3. Mask PII, `pii.view`, audit reveals | **The real exposure.** Done |
| 4. Export controls, audit, watermark | **There are no server-side exports.** Reframed and done; the watermark does not fit either |
| 5. Masked copy of production for testing | Fits as written. Done |
| 6. Remove sensitive data from logs | Fits as written. Done |

## 1. HTTPS and HSTS — verified, not changed

Measured rather than assumed:

| | Result |
|---|---|
| App's own HSTS header | `max-age=31536000; includeSubDomains` — one year, from helmet 8.3.0's default |
| `http://rvp-server.onrender.com` | `301` to HTTPS |
| `http://rvpindustries.co.in` | `308` to HTTPS |
| TLS termination | Render and Vercel, both TLS 1.2+; not ours to configure |

So this item needed no code. Writing a change for its own sake would have been worse than saying
so. **One decision deliberately not taken:** adding `preload` to the HSTS header. Preloading is
hard to reverse — getting off the list takes months, and in the meantime any subdomain that is not
HTTPS stops resolving for every browser that has the list. That is a DNS decision about
`rvpindustries.co.in` and its subdomains, not a code decision, so it is flagged rather than made.

## 2. Field-level encryption — deferred, with reasons

The plan names bank account numbers, Aadhaar and PAN. **This schema has no Aadhaar or PAN column
anywhere.** Of what remains:

- `Party.bankAccountNumber` — suppliers' accounts. Genuinely sensitive.
- `Party.gstin`, `Transport.gstin`, `CompanyProfile.gstin` — **printed on every invoice.** Public
  by design; encrypting them would be theatre.
- `CompanyProfile.bankAccountNumber` — RVP's own account, printed on invoices and payment emails
  **on purpose**, so that buyers can pay. Encrypting it would break invoicing to protect a number
  we publish.

That leaves one column. Encrypting it means ciphertext and `keyVersion` columns, a lookup hash, key
management in Render's environment, a reviewed backfill, and teaching the Tally sync, the FY
archive and the party statements to decrypt — for a measure that Supabase's encryption at rest
already partly provides. Field-level encryption would add protection against a leaked dump or a
read-only SQL user, which is real but narrow.

The masking, permission and audit work in item 3 addresses where the data was actually leaking
today, at a fraction of the blast radius. So item 2 is **deferred as a recorded decision**, not
left as an oversight. If it is taken up later, the scope is one column.

## 3. Masking, enforced on the server

**The exposure:** `listParties` returned the whole Party row — `bankAccountNumber` included — to
anyone holding `master.party.view`, which every USER has. `master.party.bank.view` and `pii.view`
both existed in the permission table and were enforced **nowhere**. The distinction the code had
already modelled was decorative.

Now masked in `lib/pii.ts` on the way out, before serialisation. Hiding the field in the UI would
not be security — the row is in the JSON either way, and the network tab is one keystroke away.
Either `master.party.bank.view` or `pii.view` lifts the mask.

**Only the account number is masked**, not the IFSC or the bank name. An IFSC identifies a branch
and is published by the bank; a bank name is a bank. Masking them would make a party statement
unreadable while protecting nothing. The account number is the part that, combined with the public
IFSC, lets someone move money.

Two details the tests forced out:

1. **The mask caps at six `X`s** rather than matching the value's length, because a mask as long as
   the account tells you how long the account is, which narrows a guess.
2. **A value of four characters or fewer is hidden entirely.** Keeping "the last four" of a
   four-digit number prints all of it.

### Reveals are audited

`GET /parties/:id/bank` returns the real value and writes a `party.bank.reveal` row naming who
looked at which supplier, and when. A separate endpoint rather than a flag on the list, for two
reasons: the audit row stays specific, where auditing the list would record only that someone
opened a screen; and the bulk path then has no way to return the real value at all, so a future
caller cannot opt itself in.

The row records *that* `bankAccountNumber` was revealed, **not the number** — an audit trail that
stores the account every time someone looks at it becomes the leak. Nothing is recorded when the
party has no bank details on file, which would be noise, and this trail has already been through
one round of being 61% noise (see [PHASE-4](PHASE-4.md)).

### The one behavioural change, checked caller by caller

`client/src/lib/partyStatement.ts` prints the party's own bank details on the party statement PDF,
and it is the **only** client consumer of this field. A USER generating that statement now sees
`XXXXXX7890`. `brokerStatement.ts`, `InvoiceDocument.tsx` and the rest use `CompanyProfile`'s own
account, which is published on invoices by design and is untouched.

## 4. Export controls — recorded, not prevented

`exceljs` and `jspdf` are **client** dependencies. Every spreadsheet and PDF export is assembled
in the browser out of data it has already fetched, so a `report.export` check cannot gate what the
browser does with bytes it already holds.

What the server *can* see is the fetch that feeds the export. `middleware/bulkReadAudit.ts` wraps
`res.json` once, centrally, and records a `data.bulk_read` row whenever a GET returns at or above
`BULK_READ_AUDIT_ROWS` (default 500) — with the path, the row count and the scrubbed query string,
because `?all=true` is what distinguishes a register dump from a page. At or above
`BULK_READ_ALERT_ROWS` (default 5000) it also logs `[bulk-read]` with the size and who asked.

Wrapped centrally rather than asking each controller to report its own count: a call site that has
to be remembered is one a future endpoint forgets, which is the same reasoning as the Phase 4
audit extension.

### The gate I did not add

Requiring `report.export` for `?all=true` was the obvious next step and would have been a bug. The
dues and ledger pages **must** fetch `?all=true` or they compute phantom dues from a truncated
page, and a USER holds `report.view` but not `report.export`. Gating it would have broken the dues
screens for every ordinary user, in the name of security. Recording beats breaking.

### The watermark does not fit either

I proposed watermarking "the PDFs the server already generates" and then looked at what they are:
`invoicePdf.ts` produces GST tax invoices, `notePdf.ts` credit and debit notes, and the statement
PDFs go to suppliers and buyers over WhatsApp. Every one is a **document sent to a third party**,
not an internal export. Stamping a customer's tax invoice with an internal username and timestamp
would be wrong, and arguably not compliant. There is no internal-export PDF to watermark, so none
is watermarked.

**What this honestly does not do:** it does not stop anyone exporting. Someone with legitimate
read access can still pull a register into a spreadsheet and take it home. What changed is that it
is no longer invisible.

## 5. A masked copy to test against

`scripts/mask-database.mjs` turns a restored copy into something safe to hand around: party bank
accounts, IFSCs, phones and emails replaced; user password hashes scrambled, MFA secrets cleared,
`mustChangePassword` set; company bank details replaced; driver phones replaced; and every
`UserSession` deleted, so a token from the real deployment cannot be replayed against the copy.

Names, GSTINs, commodities and **every transaction, weight and amount are kept** — the point is to
test against realistic volume and shape. GSTINs in particular stay, because they are printed on
invoices anyway and a masked one breaks the GST reports.

Masked values are derived by hashing the row id, so they are stable: the same party masks the same
way every time, and "is this the same account" checks still behave.

**Passwords are scrambled, not replaced with a known one.** A dev password written into a
committed script is a secret in code, and the standing rule for this project is that there are
none. After masking, no production password works; reset one through the normal admin flow.

### The guards, and why they are shaped that way

This is the most dangerous script in the repository — pointed at the wrong database it destroys
suppliers' bank details. So it:

1. reads `MASK_TARGET_DATABASE_URL` and **never falls back to `DATABASE_URL`**, so forgetting to
   set it does nothing at all;
2. refuses if the target resolves to the same host *and* database as `DATABASE_URL`;
3. is a dry run unless `--apply` is given;
4. with `--apply`, also requires `--confirm=<host>` matching the target's own host — a flag you can
   add from muscle memory is not a guard, so the operator has to read and retype the thing they are
   about to overwrite;
5. runs in one transaction, so a failure half way rolls back rather than leaving a half-masked
   database that looks fine.

A "does the database name say dev" check would have been worthless here: a Supabase database is
called `postgres` whatever project it belongs to. Hence the retype-the-host rule instead.

All four refusals were exercised before committing, not assumed.

## 6. Keeping sensitive values out of the logs

Render keeps stdout, and anyone who can read the service logs can read what we printed there.
Two places put real request bodies in: the weighbridge controller logs `req.body` as metadata, and
the WhatsApp controller concatenates `JSON.stringify(req.body)` straight into the message string.
A supplier's bank account reached the log the first time a payment request failed validation.

Two mechanisms, and **only the first is reliable**:

1. **By key name**, recursively — the mechanism. A field called `bankAccountNumber` is redacted
   wherever it appears and whatever it holds, so a new endpoint that logs a whole row is covered
   without anyone remembering to think about it.
2. **By pattern inside strings** — a backstop. JWTs, bearer and basic headers, argon2 and bcrypt
   hashes, PANs, sensitive `key=value` pairs pasted into a message, and long digit runs.

**The digit rule deliberately starts at 11 characters** so a ten-digit Indian mobile stays
readable. Phone numbers are in these logs constantly and are needed to debug a WhatsApp send, and
a scrubber that makes real faults harder to diagnose will be switched off. The cost is stated
rather than hidden: a nine- or ten-digit account number **in free text** is not caught by the
pattern. The key-name rule is what covers it when it is a field, which is the ordinary case.

This is a **separate list from the audit trail's**, which deliberately *keeps*
`bankAccountNumber` — "this supplier's account changed from X to Y" is the most important thing it
records.

It returns copies rather than mutating (logging a party must not rewrite the party), tolerates
cycles (a logged request or Prisma object may contain one, and a stack overflow inside the logger
would take down whatever it was reporting), and keeps an `Error` an `Error` so winston's own
formatting still applies.

### The hole that green tests hid

Metadata keys land directly on winston's `info` object, and `scrub` only inspects the keys of
objects it walks *into* — so the top level was never key-checked. **A top-level `{ password }`
reached the log in the clear.**

The suite passed anyway, because its one metadata case used
`bankAccountNumber: '50100234567890'` — and a 14-digit run is caught by the free-text pattern. The
key-name rule was doing nothing there, and the test could not tell the two mechanisms apart.

Found by reading the actual console output rather than trusting the green run. `logger.test.ts` now
asserts a *short* credential that matches no pattern, which is the only way to distinguish them,
and it fails against the previous wiring.

The transport-level tests exist for a second reason: winston carries `level` and `message` on
**symbol** keys as well as string ones, and the transports read the symbols. A format that returns
a fresh object silently drops them and every line loses its level — the logs keep working, so
nothing fails, they are just quietly wrong.

## The public invoice bucket (PHASE-6B M2) — step one of three

**The hole, measured today:** the `invoices` bucket is public, and
`curl https://<project>.supabase.co/storage/v1/object/public/invoices/<name>` returns `200`. It
holds supplier invoice PDFs, kata slips, payment and support screenshots, verification PDFs and
weighbridge slip images. Object names are 16 random bytes, so nobody can *enumerate* them — but the
URLs are stored in twelve database columns, shared over WhatsApp and email, and **never expire and
cannot be revoked.** Anyone ever forwarded one can read that invoice, with its party name, GSTIN
and amounts, for ever.

### Why authentication alone cannot fix it

The files are fetched by things that cannot sign in. WhatsApp's media fetcher pulls the URL
server-to-server with no headers; in the browser they are loaded by `<img src>` and `<a href>`,
which cannot send an `Authorization` header. So the authorization has to live **in the URL** and
expire.

That is already the pattern here: the weighbridge slip is served from our own endpoint with an HMAC
token in the query string, precisely so WhatsApp can fetch it. `lib/fileAccessToken.ts` generalises
it and adds the part the slip link is missing — **an expiry.** The slip token is HMAC over the id
and the paid-at time, so it is also a forever-link, just on our domain rather than Supabase's.

The signature covers the object name **and** the expiry. Signing the name alone would let anyone
extend their own link indefinitely by editing `exp`; signing the expiry alone would let one
invoice's link open another's. Both are tested.

`GET /api/files/:name?exp=…&sig=…` verifies the token and **302s to a 60-second Supabase signed
URL** rather than streaming the bytes. Streaming would put every invoice download through Render,
which bills outbound traffic — the same reason the CCTV relay was moved onto the LAN bridge.

Mounted **ahead of the global `requireAuth`**, which is what makes it reachable at all; a
`permission: null` row in the route table would not have been enough, since the table is only
consulted after authentication has already happened. The row is there anyway, for documentation and
for the audit script's coverage.

### Verified against the real bucket, not asserted

| Check | Result |
|---|---|
| No token | `403` |
| Malformed object name (`../`, `.html`, wrong length) | `404` |
| Forged signature | `403` |
| Expired token | `403`, "that link has expired" |
| Valid token | `302` → `/object/sign/…` (signed, not public) |
| Following the redirect | `200`, 5,059,482 bytes, `application/pdf` |

The route-permission coverage test from Phase 2 failed when this route appeared, because a new
public route has to be added to a reviewed list by hand. That is the mechanism working.

### What is NOT done, and so the hole is NOT yet closed

This is the serving machinery only. Deliberately so: switching everything at once, across twelve
columns and five client files, risks breaking invoice viewing and WhatsApp document sends in
production.

1. **Read paths still return the stored public URL.** Nothing uses `mintFileUrl` yet, so no
   behaviour has changed and nothing can break.
2. **Uploads still store the public URL.** `objectNameFromStored` already reads both shapes, so
   switching what is written is safe whenever it happens.
3. **The bucket is still public** — and that is the step that actually closes it. Flipping it is a
   deliberate act with a consequence that cannot be undone: **every link already sent over WhatsApp
   or email stops working.** Like the `REVOKE` in [PHASE-4](PHASE-4.md), it is left for a knowing
   decision rather than made on someone's behalf.

## Closing an item Phase 6B deferred here

[PHASE-6B](PHASE-6B.md) listed "request bodies logged verbatim in two places (M6)" against Phase 5.
Item 6 above closes it: the weighbridge controller's `logger.warn('...', req.body)` and the
WhatsApp controller's `JSON.stringify(req.body)` are both scrubbed now — the first by key name, the
second by pattern, which is why both mechanisms had to exist.

Its other Phase 5 assignment, the public invoice bucket, is **not** closed. See Left open.

## Tests

`npm test` in `server/` — **68 files, 787 tests.** 56 new.

## Left open

| Item | Where |
|---|---|
| Field-level encryption (item 2) | Deferred by decision, scope is one column — see above |
| `report.export` is still enforced nowhere | Deliberate: there is nothing server-side to gate, and gating `?all=true` would break the dues pages. It stays a declared-but-unused permission until there is a server-side export to attach it to |
| HSTS `preload` | A DNS decision about `rvpindustries.co.in`, flagged not taken |
| `securityAlertEmails` is unset | So the bulk-read alert is a log line only. Wiring it to email is small once recipients exist — carried over from Phase 1 |
| No masked copy has actually been made | The script's guards are tested; the end-to-end run needs a restored copy to point at |
| **The invoice bucket is still public (M2)** | The serving machinery is built and verified end to end; steps 2 and 3 — switching the read paths onto `mintFileUrl`, then making the bucket private — are what close it. See above |
| Bulk-read recording not yet confirmed in production | The unit tests cover the logic and nothing has made a 500-row fetch since it deployed; the first `data.bulk_read` row with a non-localhost IP will confirm the wiring |
