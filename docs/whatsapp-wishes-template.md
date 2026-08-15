# Wishes broadcast — drafted template (EN)

## Status

**Not yet submitted to Meta.** `WISHES` has no Fast2SMS `message_id`
configured (see `DEFAULT_TEMPLATE_IDS` in
`server/src/services/whatsapp.service.ts`), so every send from
**Settings → Wishes** logs `SKIPPED` in `WhatsAppLog` until one is set.
Submit the body below on the Fast2SMS WhatsApp panel (same shared KNM
number used by every other template), wait for Meta approval, then set:

- `DEFAULT_TEMPLATE_IDS.WISHES` in `whatsapp.service.ts` (or
  `FAST2SMS_TMPL_WISHES` on Render for a no-deploy fix)

## Why one template covers every occasion

Every other template in this app is approved per business event
(PO created, payment sent, dispatch...). A "wishes" message is different —
the occasion changes (Diwali, Independence Day, Eid, Christmas...) but the
*shape* of the message never does: a greeting, a short warm message, and a
graphic. Rather than submitting a new template per festival (which Meta
would also be slow to approve on short notice — a Diwali template approved
in September doesn't help you send by Diwali), the two variable parts (the
recipient's name and the Gemini-drafted occasion text) are folded into a
single generic template, exactly like `PARTY_LEDGER` is reused for both
party and broker ledger statements. The occasion name itself is not a
separate variable — it is written naturally into `{{2}}` by the drafting
step (e.g. "Wishing you a joyous Diwali...") so the template body doesn't
need to know which occasion it is.

## Proposed name

`rvp_wishes` (IMAGE header, category Marketing — this is a proactive,
non-transactional message, unlike every other template in this app which is
Utility)

**Marketing-category templates need the recipient's opt-in under Meta's
policy**, and typically cost more per conversation than Utility templates.
Consider getting each party/driver to reply "yes" once (any inbound message
opens a 24-hour session window) or, if Meta's console offers it for this
business, requesting Utility categorization on the grounds that this is a
low-frequency (a handful of times a year), business-identity message rather
than a promotion. Whichever category Meta assigns, the code doesn't change —
only the id configured above matters.

## Variable contract — 2 vars, IMAGE header

| Slot | Value | Example |
| --- | --- | --- |
| header | Gemini-generated occasion graphic (public URL, `media_url`) | — |
| `{{1}}` | Recipient name | `Ramesh Traders` |
| `{{2}}` | Occasion message body (Gemini-drafted, edited by the sender before send) | `Wishing you and your family a joyous Diwali, filled with light, prosperity and happiness.` |

Matches the fan-out in `server/src/controllers/wishes.controller.ts`
(`sendWishBroadcast`), which calls `sendWhatsAppTemplate` once per recipient
with `templateKey: 'WISHES'`, `mediaUrl: <generated image>`,
`variables: [name, messageText]`.

No newlines inside `{{2}}` — see
`docs/whatsapp-payment-reminder-templates.md` for why a newline inside a
template variable gets a message accepted by Fast2SMS but silently dropped
by WhatsApp. The drafting step keeps the generated text to a single
paragraph for this reason.

Sample values for the approval form: `Ramesh Traders`, `Wishing you and
your family a joyous Diwali, filled with light, prosperity and happiness.`

## Body

**EN**
```
🎉 Dear {{1}},

{{2}}

Warm regards,
*RVP INDUSTRIES*
*PUNGANUR*
```

## Recipients and targeting

Not every occasion goes to everyone. Independence Day, New Year etc. go to
**all** recipients; a religious festival (Diwali, Eid, Christmas...) goes
only to parties/drivers tagged with the matching `WishCategory`
(`HINDU` / `MUSLIM` / `CHRISTIAN` / `OTHER`) on the Wishes page. Untagged
parties/drivers are included in "Everyone" sends but skipped by a
category-filtered one — see `WishCategory` in `schema.prisma`. "Owners"
(the Settings → WhatsApp alert-recipient list) has no religion tag and is
just an on/off group, since it is typically the same small family/ownership
group regardless of occasion.
