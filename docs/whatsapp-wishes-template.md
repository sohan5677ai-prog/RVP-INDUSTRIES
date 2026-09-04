# Wishes broadcast — template (EN)

## Status

**APPROVED.** Meta approved under template name `rvp_rema` on the shared KNM
number (`+917207146094`).

- **Fast2SMS Message ID:** `31089` (wired in `DEFAULT_TEMPLATE_IDS.WISHES` in `server/src/services/whatsapp.service.ts`)
- **Meta Template ID:** `2139451610260693`
- **Category:** `Marketing`
- **Language:** `en`
- **Sender Number:** `+917207146094`

Env override (optional): `FAST2SMS_TMPL_WISHES`

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

## Approved Name

`rvp_rema` (IMAGE header, category Marketing — this is a proactive,
non-transactional message, unlike every other template in this app which is
Utility)

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

## Body

**EN**
```
🎉 Dear {{1}} ,

{{2}}

Warm regards,
RVP INDUSTRIES
PUNGANUR
```

## Recipients and targeting

Not every occasion goes to everyone. Independence Day, New Year etc. go to
**all** recipients; a religious festival (Diwali, Eid, Christmas...) goes
only to parties/brokers/transports/drivers tagged with the matching `WishCategory`
(`HINDU` / `MUSLIM` / `CHRISTIAN` / `OTHER`) on the Wishes page. Untagged
parties/brokers/transports/drivers are included in "Everyone" sends but skipped by a
category-filtered one — see `WishCategory` in `schema.prisma`. "Owners"
(the Settings → WhatsApp alert-recipient list) has no religion tag and is
just an on/off group, since it is typically the same small family/ownership
group regardless of occasion.
