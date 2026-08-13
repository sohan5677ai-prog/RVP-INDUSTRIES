# Owner daily business snapshot

A new daily alert (use case #12) that gives the owners a one-glance "how are
we doing" every morning: total receivable (everything, due or not), the
overdue slice of it, total payable, how many sale invoices are overdue and
still uncleared, and net profit to date - closing with a fixed line of
encouragement so it reads as a morning greeting, not just a ledger dump. Runs
at 06:00 IST, alongside `rvp_owner_due_today` (same schedule, separate
message - see `whatsapp-owner-due-today-template.md`). Distinct from
`rvp_owner_dues` (09:00 IST), which itemises the top overdue buyers rather
than giving this five-number business overview.

## Not yet approved

`OWNER_BUSINESS_SNAPSHOT` has no Fast2SMS `message_id` yet - it needs to be
submitted and approved the same way the other owner templates were. Until an
id is set (via `FAST2SMS_TMPL_OWNER_BUSINESS_SNAPSHOT` or
`DEFAULT_TEMPLATE_IDS` in `server/src/services/whatsapp.service.ts`), every
send logs `SKIPPED` in `WhatsAppLog` and nothing goes out - the code and
06:00 IST cron schedule are wired and idle, waiting on the id. Once approved,
also add a `FAST2SMS_TMPL_OWNER_BUSINESS_SNAPSHOT` entry (`sync: false`) to
`render.yaml`, matching the other `FAST2SMS_TMPL_OWNER_*` rows.

## Template to submit on Fast2SMS

Name: `rvp_owner_snapshot`. Category: **Utility**. Language: **English**. No
header. House style matches the other internal-alert templates - bold title,
no "Namaste" greeting, no sign-off (this goes to staff, not a party) - with
one fixed line of genuine, business-appropriate encouragement baked into the
body (not a variable - it never changes), so it stays inside Utility.

```
🌅 *Good Morning — RVP Daily Business Snapshot*

As on: *{{1}}*

💰 Total Receivable (all buyers, due or not): *{{2}}*
⏰ Overdue Receivable (past due date): *{{3}}*
📤 Total Payable (to suppliers): *{{4}}*
🧾 Overdue invoices pending clearance: *{{5}}*
📈 Net Profit till date: *{{6}}*

Every rupee collected builds a stronger business. Keep pushing! 💪
```

| Slot | Content | Example |
|------|---------|---------|
| `{{1}}` | Today's date, IST | `13-Aug-2026` |
| `{{2}}` | Total outstanding across ALL buyers, including bills not yet due (same figure as `rvp_owner_dues`'s receivable) | `₹42,18,500` |
| `{{3}}` | The overdue SLICE of `{{2}}` - past due date and still uncollected (same figure as `rvp_owner_dues`'s overdue) | `₹11,04,900` |
| `{{4}}` | Total outstanding across all suppliers (grain + dust/byproduct bills, net of payments made) | `₹18,64,200` |
| `{{5}}` | Count of sale invoices that are PAST due date and still not fully collected - not every unsettled invoice, only the ones actually overdue | `5` |
| `{{6}}` | Net profit to date (locked Pappu P/L + husk-pool net, the same figure the P&L page headlines) | `₹9,32,760` |

The closing line is fixed template text, not a variable - six variables
total. Sample values for Meta's approval form: same as the example row above.

**Total vs. overdue, deliberately both shown**: `{{2}}` is every buyer's outstanding book value, due or not - the full exposure. `{{3}}` and `{{5}}` are the subset actually past its due date, i.e. money that should already be in hand - what the owner should be chasing today. Showing only the total would hide how much of it is actually late; showing only overdue would hide the full size of the book.

## Where the numbers come from

`runOwnerBusinessSnapshot()` in `server/src/jobs/whatsappJobs.ts` gathers all
four in parallel:

- **Total Receivable** - `computeBuyerDues()` in `salesDues.service.ts`,
  `.totalReceivable` (every buyer's unsettled shipments, due or not - same as
  the Sale Dues page and the `rvp_owner_dues` digest).
- **Overdue Receivable** - the same call's `.totalOverdue` - the subset of
  `.totalReceivable` whose due date has passed (`dueDate = (deliveredDate ??
  dispatchDate) + order.dueDays`, and a shipment not yet marked `DELIVERED`
  can never be overdue - see the `inTransit` rule in `salesDues.service.ts`).
- **Total Payable** - `computeSupplierDues()`, a new function in
  `server/src/services/purchaseDues.service.ts`. It mirrors the "Net
  Outstanding Dues" math on the Purchase Dues page: verified grain purchases
  + dust/byproduct purchases, settled oldest-first per supplier against that
  supplier's pooled `SUPPLIER` payments.
- **Overdue invoices pending clearance** - the count of invoices across
  `computeBuyerDues()`'s `buyers[].overdueInvoices`, NOT `buyers[].invoices` -
  only bills actually past their due date count as "pending clearance" here;
  a bill not yet due isn't something to chase.
- **Net Profit** - `computeProfitLossSummary()` in
  `server/src/controllers/ledger.controller.ts` (the same computation
  `getProfitLoss` serves to the P&L page), `.totals.netProfit` - the locked
  figure the page headlines, not the estimated one.

## Motivation line

Fixed: "Every rupee collected builds a stronger business. Keep pushing! 💪" -
part of the approved template body, not a template variable, so there is no
code to maintain for it.

## Where it goes

`fanOutToAlertRecipients()` - the same `alertRecipients` list (Settings →
Dispatch & alert recipients) as every other owner digest.

## Idempotency

Keyed by `istDayKey()`, same pattern as `runOwnerDuesDigest` -
`lastSentAt('OWNER_BUSINESS_SNAPSHOT', dayKey)` guards against a restart or a
manual `/webhooks/whatsapp/jobs/business-snapshot` trigger double-sending the
same day's snapshot. Manual trigger: `business-snapshot` (secret-guarded, see
`CRON_SECRET`).
