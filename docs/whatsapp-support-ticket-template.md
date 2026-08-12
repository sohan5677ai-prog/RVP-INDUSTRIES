# Support ticket → WhatsApp

The topbar's **Contact support** button (life-buoy icon, left of the theme
toggle) captures the page, the screen and the browser, takes the reporter's own
sentence, stores a `SupportTicket` row, and sends it out on WhatsApp.

Both templates are approved and their message_ids are wired into
`DEFAULT_TEMPLATE_IDS` in `server/src/services/whatsapp.service.ts`:
`rvp_support_ticket` → `28539`, `rvp_support_ticket_text` → `28541`. Before
that, every send logged `SKIPPED` in `WhatsAppLog` — the ticket was still
stored, and the reporter was told plainly that the alert did not go out (see
`notifiedStatus` on the row and the "not sent" badge on `/support`).

## Templates to submit on Fast2SMS

Two templates, exactly as with `rvp_payment_sent` / `rvp_payment_sent_text`: one
carrying the screen capture in an image header, one plain text for when the
browser could not capture. **They must not share a message_id** — there is a
guard in `notifySupportTicket` that logs an error if they do, because a ticket
with no screenshot would otherwise go out on copy that promises one.

Both take the **same four variables in the same order**:

| Slot | Content | Example |
|------|---------|---------|
| `{{1}}` | Reporter and role | `Ramesh (USER)` |
| `{{2}}` | Page, label + route | `Purchase Orders (/purchase-orders)` |
| `{{3}}` | What they typed | `The pending column shows 0 for DCS but there are 3 lorries.` |
| `{{4}}` | When, IST | `11-Aug-2026 04:35 PM` |

Category: **Utility**. Language: **English**. Matches the house style of the
other internal-alert templates (`rvp_owner_dispatch`/`_weekly`/`_dues`) — a
bold title line, no "Namaste" greeting, no sign-off, since this goes to staff
not a party.

### 1. `rvp_support_ticket` — header: **IMAGE**

```
🛠 *Support Ticket — RVP ERP*

Reported by: *{{1}}*
Page: *{{2}}*
Issue: {{3}}
Time: *{{4}}*

Screenshot of the screen is attached above.
```

### 2. `rvp_support_ticket_text` — **no header**

```
🛠 *Support Ticket — RVP ERP*

Reported by: *{{1}}*
Page: *{{2}}*
Issue: {{3}}
Time: *{{4}}*

(No screenshot captured for this report.)
```

Sample values for Meta's approval form (both templates, same four):

| Var | Sample |
|---|---|
| `{{1}}` | Ramesh (USER) |
| `{{2}}` | Purchase Orders (/purchase-orders) |
| `{{3}}` | The pending column shows 0 for DCS but there are 3 lorries listed. |
| `{{4}}` | 11-Aug-2026 04:35 PM |

Checked into `DEFAULT_TEMPLATE_IDS` as above; override on Render with
`FAST2SMS_TMPL_SUPPORT_TICKET` / `FAST2SMS_TMPL_SUPPORT_TICKET_TEXT` if either
message_id ever needs to change without a deploy.

## Where it goes

To **one number: 8019965187**, the developer's — not the alert recipient list,
and never the owners. A support ticket is a bug report with a screenshot of
somebody's own mis-click on it; an owner cannot act on it, and every extra copy
is a billed conversation. Override with `SUPPORT_WHATSAPP_NUMBER` on Render if
the person on call changes; there is deliberately no Settings field for it.

This is the one internal template that does **not** go through
`fanOutToAlertRecipients` — the weekly summary and dues digest still do. With
`WHATSAPP_TEST_MODE` on (the default) the send is still rerouted to the test
number like every other message.

## Two constraints that are easy to trip over

**No newlines in a variable.** The note comes from a textarea, so it will
contain the Enter key. Meta silently drops a message whose variable contains a
newline — Fast2SMS still returns a provider id and the ERP still logs `SENT`
(see `whatsapp-payment-reminder-templates.md`). `notifySupportTicket` collapses
the note's line breaks to ` · ` before sending. Do not remove that.

**The image must be publicly fetchable.** The capture is uploaded to the
Supabase Storage bucket and the message carries its public URL; Meta fetches it
server-side. If that bucket is ever made private, the image header will fail
while the text template keeps working.

## The capture is a DOM render, not a screenshot

`html-to-image` redraws the page into a PNG. A true screen grab would need
`getDisplayMedia()`, which forces a "choose what to share" picker on every
single report and would defeat a one-press button.

Fonts are deliberately **not** embedded (`skipFonts: true`). The app loads the
Anek/Noto families from `fonts.googleapis.com`, and html-to-image tries to
inline every stylesheet it can see: it cannot read that cross-origin sheet's
`cssRules`, falls back to re-fetching it, and measured **4x slower (2.0s vs
0.5s)** while throwing console errors into the very error buffer the ticket
attaches — and stalling for tens of seconds on a slow connection. The cost is
that one decorative display heading renders in a fallback face. Body text,
tables, figures and layout are unaffected.

Anything marked `data-support-exclude="true"` is left out of the capture, which
is how the button and its own dialog stay out of the picture.
