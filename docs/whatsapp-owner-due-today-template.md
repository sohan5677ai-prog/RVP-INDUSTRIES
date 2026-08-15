# Owner "bills due today" digest

A new daily alert (use case #11) that tells the owners which sale invoices
fall due **today**, before the business day starts. Distinct from the
existing `rvp_owner_dues` digest (09:00 IST, always sends, summarises the
whole receivable book) - this one is itemised, runs at 06:00 IST, and stays
silent on a day with nothing due.

## Approved

Approved 2026-08-15 as **Utility**, under the name `due_today` (submitted
under that name rather than the drafted `rvp_owner_due_today` below) -
Fast2SMS message_id `28801`, on the shared KNM number (+91 72071 46094).
Wired in `DEFAULT_TEMPLATE_IDS['OWNER_DUE_TODAY_DIGEST']` in
`server/src/services/whatsapp.service.ts`; `FAST2SMS_TMPL_OWNER_DUE_TODAY_DIGEST`
still overrides it if the id ever needs to change without a deploy.

## Template as submitted to Fast2SMS

Name: `rvp_owner_due_today` (drafted; approved under `due_today` instead -
see above). Category: **Utility**. Language: **English**. No header. House
style matches the other internal-alert templates - bold title, no "Namaste"
greeting, since this goes to staff not a party. The approved copy closes with
one fixed explanatory sentence (not a variable) instead of the drafted
sign-off-free ending.

```
📆 *Bills Due Today*

Date: *{{1}}*
Total due today: *{{2}}* across *{{3}}* bill(s)

{{4}}

All the above bills Due date is today after the Respective Credit Periods of each bill
```

| Slot | Content | Example |
|------|---------|---------|
| `{{1}}` | Today's date, IST | `13-Aug-2026` |
| `{{2}}` | Total receivable due today | `₹4,52,300` |
| `{{3}}` | Count of bills due today | `3` |
| `{{4}}` | Itemised list, one comma-separated line | `RVP/62/26-27 ₹1,75,279 - Sri Lakshmi Traders (via Ramesh), RVP/63/26-27 ₹1,73,820 - Vimal Industries (direct), RVP/64/26-27 ₹1,03,201 - Konda Rice Mill (via Suresh)` |

## Why it can go silent

Every other owner digest fires unconditionally - `rvp_owner_dues` says "No
overdue dues 🎉" rather than skip. This one is different on purpose: getting
pinged every morning about bills due *today* only matters on the mornings
there are any. `runOwnerDueTodayDigest()` in `server/src/jobs/whatsappJobs.ts`
checks `portfolio.dueToday.length === 0` and returns without calling
`sendOwnerDueTodayDigest` at all when there's nothing due - no `WhatsAppLog`
row, no message, on a clean day.

## What counts as "due today"

`computeBuyerDues()` in `server/src/services/salesDues.service.ts` now also
returns `dueToday: InvoiceDue[]` - every unsettled invoice whose `dueDate`
falls on the same IST calendar day as `asOf`, via a new `isSameIstDay()`
helper (`istCalendar()` from `server/src/lib/istDate.ts`, not the process
clock - see `docs/server-dates-ist` convention). Same `inTransit` exclusion as
`overdue`: a shipment not yet marked `DELIVERED` has no due date that has
"started" yet, so it can't be due today either.

`dueTodayListText()` formats the list, largest amount first (the bill an
owner would chase first), one line, no newlines - same constraint as
`invoiceListText()` (see `whatsapp-payment-reminder-templates.md`): Meta
silently drops any template variable containing a newline. Capped at 10 with
a trailing `+N more`.

## Where it goes

`fanOutToAlertRecipients()` - the same `alertRecipients` list (Settings →
Dispatch & alert recipients) as `rvp_owner_dues` and `rvp_owner_weekly`, not
a party and not the developer's support number.

## Idempotency

Keyed by `istDayKey()` exactly like `runOwnerDuesDigest` - `lastSentAt('OWNER_DUE_TODAY_DIGEST',
dayKey)` guards against a restart or a manual `/webhooks/whatsapp/jobs/due-today`
trigger double-sending the same day's digest.
