# Multilingual WhatsApp templates (EN / TE / TA / KN / HI)

Six party-facing templates get a copy in Telugu, Tamil, Kannada and Hindi:

| Key | Template | Goes to | Vars |
| --- | --- | --- | --- |
| `PO_CREATED` | `rvp_po_created` | supplier, on PO create | 4 |
| `STOCKIN_CONFIRMED` | `rvp_stockin_confirmed` | supplier, on stock-in | 4 |
| `VERIFICATION_STATEMENT` | `rvp_verification_statement` | supplier, on weight verification (PDF header) | 4 |
| `PAYMENT_SENT` / `PAYMENT_SENT_TEXT` | `rvp_payment_sent` (+ `_text`) | payee, on payment (image header / no header) | 4 |
| `PAYMENT_REMINDER` | `payment_reminder` | buyer + broker, sales dues | 3 |
| `REMINDER` | `rvp_reminder` | supplier, pending loads | 3 |

Owner/internal templates (`OWNER_*`, `SUPPORT_TICKET`) stay English only — nobody
in the office needs them translated.

## How a language is chosen

`Party.waLanguage` (and `Broker.waLanguage`) — a dropdown on the party/broker
form, `EN` for everyone until it is changed. At send time
`templateId(key, language)` in [whatsapp.service.ts](../server/src/services/whatsapp.service.ts)
resolves, first hit wins:

1. `FAST2SMS_TMPL_<KEY>_<LANG>` — env override for the language copy
2. `LANGUAGE_TEMPLATE_IDS[lang][key]` — checked-in id for the language copy
3. `FAST2SMS_TMPL_<KEY>` — env override for English
4. `DEFAULT_TEMPLATE_IDS[key]` — checked-in English id

**The English fall-back is the point.** Marking a supplier as Tamil the day
before the Tamil template clears review does not stop their PO confirmation —
they get the English one. `WhatsAppLog.language` records the language actually
used, so a column full of `EN` on a Tamil party means the id is still missing.

The internal office copy of a party message always goes out in **English**
(`sendToPartyAndInternal` forces it). Same figures, same media — a language the
office can check.

## Rules that constrain the wording

- **One approved template per language.** Meta treats each as its own template
  with its own Fast2SMS `message_id`; there is no single template that switches
  language by parameter.
- **Same variable count, same order, same meaning** in every language. The ERP
  passes one positional array; only the id changes. If a translation needs the
  amount before the name, it still has to read `{{1}}`=name, `{{2}}`=amount.
- **No newline inside a variable.** Meta silently drops the message — this is
  what killed the multi-line invoice list, see
  [whatsapp-payment-reminder-templates.md](whatsapp-payment-reminder-templates.md).
- **The ERP does not translate the values**, only the fixed wording around them.
  Party names, lorry numbers, PO numbers and invoice numbers stay as typed;
  amounts stay `₹1,75,279`; dates stay `11-Aug-2026`. So the translated body must
  read correctly with a Latin-script value dropped into it.
- Header type (document / image / none) must match the English original, or the
  send fails on missing media.

## Variable contract

Exactly what the ERP substitutes, with a live example. Any translated body must
put these in this order.

### 1. `PO_CREATED` — no header, 4 vars

| Slot | Value | Example |
| --- | --- | --- |
| `{{1}}` | Party name | `Sri Venkateswara Traders` |
| `{{2}}` | PO number, or `first to last` for a multi-lorry order | `DCS/07/26-27 to DCS/09/26-27` |
| `{{3}}` | Lorry count, optionally with the quoted tonnage in brackets | `3 (75,000 KGS)` |
| `{{4}}` | Price per kg, bare number — put the `₹` and `/kg` in the fixed text | `95.5` |

`{{3}}` is a count that *sometimes* carries a weight, so the fixed label before
it must mean "lorries", never "weight".

### 2. `STOCKIN_CONFIRMED` — no header, 4 vars

| Slot | Value | Example |
| --- | --- | --- |
| `{{1}}` | Party name | `Sri Venkateswara Traders` |
| `{{2}}` | Lorry number | `AP39TR1234` |
| `{{3}}` | The party's OWN invoice number (our PO number only as fallback) | `1042` |
| `{{4}}` | Arrival date | `11-Aug-2026` |

### 3. `VERIFICATION_STATEMENT` — **document header** (statement PDF), 4 vars

| Slot | Value | Example |
| --- | --- | --- |
| `{{1}}` | Party name | `Sri Venkateswara Traders` |
| `{{2}}` | Lorry number | `AP39TR1234` |
| `{{3}}` | Net weight, formatted with unit | `24,860 KGS` |
| `{{4}}` | Amount, formatted | `23,61,700` |

The body should point at the attached statement PDF — the header is mandatory
here, so the translated template must also be created with a document header.

### 4. `PAYMENT_SENT` (image header) and `PAYMENT_SENT_TEXT` (no header) — 4 vars

| Slot | Value | Example |
| --- | --- | --- |
| `{{1}}` | Payee name | `Sri Venkateswara Traders` |
| `{{2}}` | Amount | `5,00,000` |
| `{{3}}` | Payment date | `11-Aug-2026` |
| `{{4}}` | Reference / UTR, `-` when none | `SBIN0412998745` |

Two separate templates per language: the image one is sent when a payment
screenshot was uploaded, the text one when it wasn't. **The `_text` body must not
mention an attached screenshot** — that is the whole reason it exists.

### 5. `PAYMENT_REMINDER` — no header, 3 vars

| Slot | Value | Example |
| --- | --- | --- |
| `{{1}}` | Recipient; a broker copy reads `Broker (for Buyer)` | `Ravi Kumar (for Vimal Industries)` |
| `{{2}}` | Total outstanding | `3,49,099` |
| `{{3}}` | Comma-separated invoice list, oldest first, capped at 10 + `+N more` | `RVP/63/26-27 (₹1,75,279), RVP/64/26-27 (₹1,73,820)` |

`{{3}}` can be long. Keep the fixed text around it short, and never try to put
each invoice on its own line — see the newline rule above.

### 6. `REMINDER` (pending loads) — no header, 3 vars

| Slot | Value | Example |
| --- | --- | --- |
| `{{1}}` | Party name | `Sri Venkateswara Traders` |
| `{{2}}` | Pending lorry count | `5` |
| `{{3}}` | Per-PO breakdown, one bullet per PO | `• ₹95/kg - 3 lorries (DCS/07/26-27)` |

`{{3}}` is built with `\n` between bullets. It is the one variable in the set
that carries newlines, and it is the reason this reminder must be watched after
the first send in a new language — if it arrives blank or undelivered, flatten
the breakdown to `·`-separated on one line as the payment reminder does.

## Approved bodies

<!-- Fill from the Fast2SMS panel: English first (verbatim), then the four
     translations submitted against it. Keep the {{n}} positions identical. -->

_Pending — English originals to be pasted in, then TE / TA / KN / HI drafted
against them._

## Wiring an approved id

Once a language copy is approved, add its `message_id` to `LANGUAGE_TEMPLATE_IDS`
in `whatsapp.service.ts` (or set `FAST2SMS_TMPL_<KEY>_<LANG>` on Render for a
no-deploy fix), then send one live test to a party set to that language and check
`WhatsAppLog.language` reads the language and not `EN`.
