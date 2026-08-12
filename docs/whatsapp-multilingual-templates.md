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
| `{{3}}` | Net weight, both units (`fmtWeight`) | `24.86 MT (24,860 kg)` |
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

## Bodies

English is the approved copy as it stands in the Fast2SMS panel; the four
translations are drafted against it, emoji-for-emoji and line-for-line, so the
same variable lands in the same place in every language.

`RVP INDUSTRIES` / `PUNGANUR` stay in Latin script everywhere — it is how the
name appears on the letterhead, the invoice and the board at the gate.

### `po_created` — 4 vars, no header, category Utility

English is live: message_id **26129**, sender +917207146094. (The panel also shows
TEMPLATE ID `1366575302101445` — that is the **Meta** id and would 400. Always
take the small MESSAGE ID.)

**All five languages are approved and wired** (2026-08-11):

| Language | Template | message_id |
| --- | --- | --- |
| en | `po_created` | 26129 |
| te | `po_telugu` | 28599 |
| ta | `po_tamil` | 28598 |
| kn | `po_kannada` | 28597 |
| hi | `po_hindi` | 28596 |

The four translations live in `LANGUAGE_TEMPLATE_IDS` in whatsapp.service.ts and
are pinned by value in `whatsappLanguage.test.ts` — the ids are consecutive, so a
transposed pair would send a Tamil supplier a perfectly valid Telugu message with
nothing in the logs to show for it.

Sample values for the approval form: `Sri Venkateswara Traders`, `DCS/07/26-27`,
`3`, `95.50`.

The `*asterisks*` are WhatsApp bold and are part of the approved English body —
keep them on the same words in every language.

**EN**
```
Namaste {{1}} 🙏

Your Purchase Order with *RVP INDUSTRIES* is confirmed.

📄 PO No: {{2}}
🚛 Lorries: {{3}}
💰 Rate: ₹{{4}}*/kg*

Kindly begin dispatch and share lorry details on this number. Thank you for your association.
*RVP INDUSTRIES*
*PUNGANUR*
```

**TE — తెలుగు**
```
నమస్తే {{1}} 🙏

*RVP INDUSTRIES* తో మీ కొనుగోలు ఆర్డర్ ధృవీకరించబడింది.

📄 PO నం: {{2}}
🚛 లారీలు: {{3}}
💰 ధర: ₹{{4}}*/kg*

దయచేసి రవాణా ప్రారంభించి, లారీ వివరాలను ఈ నంబర్‌కు పంపండి. మీ సహకారానికి ధన్యవాదాలు.
*RVP INDUSTRIES*
*PUNGANUR*
```

**TA — தமிழ்**
```
வணக்கம் {{1}} 🙏

*RVP INDUSTRIES* உடனான உங்கள் கொள்முதல் ஆர்டர் உறுதி செய்யப்பட்டது.

📄 PO எண்: {{2}}
🚛 லாரிகள்: {{3}}
💰 விலை: ₹{{4}}*/kg*

தயவுசெய்து அனுப்புதலைத் தொடங்கி, லாரி விவரங்களை இந்த எண்ணுக்கு அனுப்பவும். உங்கள் ஒத்துழைப்புக்கு நன்றி.
*RVP INDUSTRIES*
*PUNGANUR*
```

**KN — ಕನ್ನಡ**
```
ನಮಸ್ತೆ {{1}} 🙏

*RVP INDUSTRIES* ಜೊತೆಗಿನ ನಿಮ್ಮ ಖರೀದಿ ಆದೇಶ ದೃಢೀಕರಿಸಲಾಗಿದೆ.

📄 PO ಸಂ: {{2}}
🚛 ಲಾರಿಗಳು: {{3}}
💰 ದರ: ₹{{4}}*/kg*

ದಯವಿಟ್ಟು ರವಾನೆ ಪ್ರಾರಂಭಿಸಿ, ಲಾರಿ ವಿವರಗಳನ್ನು ಈ ಸಂಖ್ಯೆಗೆ ಕಳುಹಿಸಿ. ನಿಮ್ಮ ಸಹಯೋಗಕ್ಕೆ ಧನ್ಯವಾದಗಳು.
*RVP INDUSTRIES*
*PUNGANUR*
```

**HI — हिंदी**
```
नमस्ते {{1}} 🙏

*RVP INDUSTRIES* के साथ आपका क्रय आदेश (Purchase Order) पुष्ट हो गया है।

📄 PO नं: {{2}}
🚛 लॉरी: {{3}}
💰 दर: ₹{{4}}*/kg*

कृपया प्रेषण शुरू करें और लॉरी का विवरण इसी नंबर पर भेजें। आपके सहयोग के लिए धन्यवाद।
*RVP INDUSTRIES*
*PUNGANUR*
```

### `stockin_confirmed` — 4 vars, no header, category Utility

Sample values: `Sri Venkateswara Traders` (native script per language),
`AP39TR1234`, `1042`, `11-Aug-2026`.

`{{3}}` is the party's OWN invoice number as typed at stock-in — often a bare
serial like `1042`, our PO number only when the arrival was booked without one.

`{{4}}` comes from `fmtDate`, which hardcodes English month abbreviations
(`11-Aug-2026`). It stays Latin inside every translated body — deliberate, see
the note at the end of this file.

Bold markers mirror `po_created`; confirm against the panel before submitting.

**EN**
```
Namaste {{1}} 🙏

We confirm arrival of your lorry at *RVP INDUSTRIES*.

🚛 Lorry No: {{2}}
📄 Invoice No: {{3}}
📅 Arrived: {{4}}

Weighment & quality verification is in progress; your statement will follow shortly.

*RVP INDUSTRIES*
*PUNGANUR*
```

**TE — తెలుగు**
```
నమస్తే {{1}} 🙏

మీ లారీ *RVP INDUSTRIES* కి చేరినట్లు ధృవీకరిస్తున్నాము.

🚛 లారీ నం: {{2}}
📄 ఇన్‌వాయిస్ నం: {{3}}
📅 చేరిన తేదీ: {{4}}

తూకం మరియు నాణ్యత పరిశీలన జరుగుతోంది; మీ స్టేట్‌మెంట్ త్వరలో పంపబడుతుంది.

*RVP INDUSTRIES*
*PUNGANUR*
```

**TA — தமிழ்**
```
வணக்கம் {{1}} 🙏

உங்கள் லாரி *RVP INDUSTRIES*-ஐ வந்தடைந்ததை உறுதிப்படுத்துகிறோம்.

🚛 லாரி எண்: {{2}}
📄 விலைப்பட்டியல் எண்: {{3}}
📅 வந்த தேதி: {{4}}

எடை மற்றும் தரச் சரிபார்ப்பு நடைபெற்று வருகிறது; உங்கள் கணக்கு அறிக்கை விரைவில் அனுப்பப்படும்.

*RVP INDUSTRIES*
*PUNGANUR*
```

**KN — ಕನ್ನಡ**
```
ನಮಸ್ತೆ {{1}} 🙏

ನಿಮ್ಮ ಲಾರಿ *RVP INDUSTRIES* ಗೆ ತಲುಪಿರುವುದನ್ನು ದೃಢೀಕರಿಸುತ್ತೇವೆ.

🚛 ಲಾರಿ ಸಂ: {{2}}
📄 ಇನ್‌ವಾಯ್ಸ್ ಸಂ: {{3}}
📅 ತಲುಪಿದ ದಿನಾಂಕ: {{4}}

ತೂಕ ಮತ್ತು ಗುಣಮಟ್ಟ ಪರಿಶೀಲನೆ ನಡೆಯುತ್ತಿದೆ; ನಿಮ್ಮ ಸ್ಟೇಟ್‌ಮೆಂಟ್ ಶೀಘ್ರದಲ್ಲೇ ಕಳುಹಿಸಲಾಗುವುದು.

*RVP INDUSTRIES*
*PUNGANUR*
```

**HI — हिंदी**
```
नमस्ते {{1}} 🙏

आपकी लॉरी *RVP INDUSTRIES* पहुँच चुकी है, इसकी पुष्टि करते हैं।

🚛 लॉरी नं: {{2}}
📄 इनवॉइस नं: {{3}}
📅 पहुँचने की तिथि: {{4}}

तौल एवं गुणवत्ता जाँच जारी है; आपका स्टेटमेंट शीघ्र ही भेजा जाएगा।

*RVP INDUSTRIES*
*PUNGANUR*
```

### `verification_statement_final` — 4 vars, **document header (PDF)**, Utility

The header is mandatory: the approval form wants a **sample PDF** uploaded, and
at send time the statement PDF must be present or Meta rejects the message. Use
any purchase statement export as the sample.

Sample values: `Sri Venkateswara Traders` (native script per language),
`AP39TR1234`, `24.86 MT (24,860 kg)`, `23,61,700`.

`{{3}}` carries BOTH units already (`fmtWeight` → `24.86 MT (24,860 kg)`), so the
fixed label must not add a unit of its own.

`₹` sits in the fixed text before `{{4}}` — the ERP sends a bare number. It is
inside the bold marker so the amount reads as one unit.

**From here on every parameter is bold.** WhatsApp bold is a SINGLE asterisk;
`**{{1}}**` would print literal asterisks to the party.

**EN**
```
Namaste *{{1}}* 🙏

Your lorry has been unloaded and verified at *RVP INDUSTRIES*. Account statement attached.

🚛 Lorry No: *{{2}}*
⚖️ Net Weight: *{{3}}*
💰 Payable: *₹{{4}}*

Please review the attached statement (PDF) and reach out for any clarification.

*RVP INDUSTRIES*
*PUNGANUR*
```

**TE — తెలుగు**
```
నమస్తే *{{1}}* 🙏

మీ లారీ *RVP INDUSTRIES* వద్ద దింపబడి, తూకం ధృవీకరించబడింది. ఖాతా స్టేట్‌మెంట్ జత చేయబడింది.

🚛 లారీ నం: *{{2}}*
⚖️ నికర బరువు: *{{3}}*
💰 చెల్లించవలసినది: *₹{{4}}*

జత చేసిన స్టేట్‌మెంట్ (PDF) పరిశీలించండి; ఏవైనా సందేహాలుంటే సంప్రదించండి.

*RVP INDUSTRIES*
*PUNGANUR*
```

**TA — தமிழ்**
```
வணக்கம் *{{1}}* 🙏

உங்கள் லாரி *RVP INDUSTRIES*-இல் இறக்கப்பட்டு எடை சரிபார்க்கப்பட்டது. கணக்கு அறிக்கை இணைக்கப்பட்டுள்ளது.

🚛 லாரி எண்: *{{2}}*
⚖️ நிகர எடை: *{{3}}*
💰 செலுத்த வேண்டியது: *₹{{4}}*

இணைக்கப்பட்ட அறிக்கையை (PDF) பரிசீலிக்கவும்; ஏதேனும் விளக்கம் தேவைப்பட்டால் தொடர்பு கொள்ளவும்.

*RVP INDUSTRIES*
*PUNGANUR*
```

**KN — ಕನ್ನಡ**
```
ನಮಸ್ತೆ *{{1}}* 🙏

ನಿಮ್ಮ ಲಾರಿಯನ್ನು *RVP INDUSTRIES* ನಲ್ಲಿ ಇಳಿಸಿ ತೂಕ ದೃಢೀಕರಿಸಲಾಗಿದೆ. ಖಾತೆ ಸ್ಟೇಟ್‌ಮೆಂಟ್ ಲಗತ್ತಿಸಲಾಗಿದೆ.

🚛 ಲಾರಿ ಸಂ: *{{2}}*
⚖️ ನಿವ್ವಳ ತೂಕ: *{{3}}*
💰 ಪಾವತಿಸಬೇಕಾದ ಮೊತ್ತ: *₹{{4}}*

ಲಗತ್ತಿಸಿದ ಸ್ಟೇಟ್‌ಮೆಂಟ್ (PDF) ಪರಿಶೀಲಿಸಿ; ಯಾವುದೇ ಸ್ಪಷ್ಟನೆಗೆ ಸಂಪರ್ಕಿಸಿ.

*RVP INDUSTRIES*
*PUNGANUR*
```

**HI — हिंदी**
```
नमस्ते *{{1}}* 🙏

आपकी लॉरी *RVP INDUSTRIES* में उतार दी गई है और तौल सत्यापित हो चुकी है। खाता स्टेटमेंट संलग्न है।

🚛 लॉरी नं: *{{2}}*
⚖️ शुद्ध वजन: *{{3}}*
💰 देय राशि: *₹{{4}}*

संलग्न स्टेटमेंट (PDF) देखें; किसी भी स्पष्टीकरण के लिए संपर्क करें।

*RVP INDUSTRIES*
*PUNGANUR*
```

### `rvp_reminder` — 3 vars, no header

Two things about this one:

- The body **ends on `{{3}}`**. The English original cleared review that way, but
  templates ending on a variable are a common rejection reason. If a translation
  comes back rejected, add the `RVP INDUSTRIES / PUNGANUR` sign-off after `{{3}}`
  — the ERP does not care, the variable position is unchanged.
- `{{3}}` is the only variable in the whole set built with newlines in it, and
  `loadPendingLoads` now writes the lorry/lorries word in the party's language,
  so the list matches the frame around it. Watch the first send in each language:
  if it silently fails to deliver, flatten the bullets onto one line.

**EN**
```
🙏 Namaste {{1}},

📢 Gentle reminder from RVP Industries regarding your pending tamarind seed loads.

🚚 Total Pending: {{2}} lorries

📋 Details:
{{3}}
```

**TE — తెలుగు**
```
🙏 నమస్తే {{1}},

📢 మీ పెండింగ్‌లో ఉన్న చింతపండు గింజల లోడ్ల గురించి RVP Industries నుండి మర్యాదపూర్వక గుర్తుచేయుట.

🚚 మొత్తం పెండింగ్: {{2}} లారీలు

📋 వివరాలు:
{{3}}
```

**TA — தமிழ்**
```
🙏 வணக்கம் {{1}},

📢 நிலுவையில் உள்ள உங்கள் புளி விதை ஏற்றங்கள் குறித்து RVP Industries-இன் அன்பான நினைவூட்டல்.

🚚 மொத்த நிலுவை: {{2}} லாரிகள்

📋 விவரங்கள்:
{{3}}
```

**KN — ಕನ್ನಡ**
```
🙏 ನಮಸ್ತೆ {{1}},

📢 ಬಾಕಿ ಇರುವ ನಿಮ್ಮ ಹುಣಸೆ ಬೀಜದ ಲೋಡ್‌ಗಳ ಕುರಿತು RVP Industries ನಿಂದ ಸೌಜನ್ಯಪೂರ್ವಕ ಜ್ಞಾಪನೆ.

🚚 ಒಟ್ಟು ಬಾಕಿ: {{2}} ಲಾರಿಗಳು

📋 ವಿವರಗಳು:
{{3}}
```

**HI — हिंदी**
```
🙏 नमस्ते {{1}},

📢 आपके लंबित इमली बीज लोड के संबंध में RVP Industries की ओर से विनम्र स्मरण।

🚚 कुल लंबित: {{2}} लॉरी

📋 विवरण:
{{3}}
```

### `rvp_payment_sent` / `rvp_payment_sent_text` / `payment_reminder`

_Awaiting the approved English bodies._

## What stays in Latin script, and why

The ERP formats values once, for every language:

- **Dates** — `fmtDate` gives `11-Aug-2026`, English month abbreviation. Kept
  deliberately: a purely numeric date invites dd/mm vs mm/dd misreading, and this
  is the same form printed on the invoice and the statement PDF the party already
  holds. Localising it would mean four month-name tables for no gain in clarity.
- **Amounts** — `fmtInr` gives `4,50,000` (Indian grouping, Western digits).
- **Names, lorry numbers, PO and invoice numbers** — passed through exactly as
  typed in the ERP, which is Latin script today.

So a Telugu supplier reads a Telugu message with Latin names, numbers and month
abbreviations in it. That is the intended result, not a gap.

The one exception is the pending-loads breakdown (`REMINDER` `{{3}}`), which the
server builds itself and therefore DOES translate the lorry/lorries word — see
`LORRY_WORDS` in whatsapp.controller.ts.

## Wiring an approved id

Once a language copy is approved, add its `message_id` to `LANGUAGE_TEMPLATE_IDS`
in `whatsapp.service.ts` (or set `FAST2SMS_TMPL_<KEY>_<LANG>` on Render for a
no-deploy fix), then send one live test to a party set to that language and check
`WhatsAppLog.language` reads the language and not `EN`.
