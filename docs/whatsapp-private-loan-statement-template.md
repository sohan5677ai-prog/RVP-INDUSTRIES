# Private loan statement — approved templates (EN / TE / HI)

## Status

**Approved and wired (2026-08-21).** All three languages are approved by Meta on
the shared KNM number (+917207146094) and wired into `whatsapp.service.ts`:

- English (`rvp_private_loan_statement`): Fast2SMS message_id **28933** (Meta template ID `1061557026326427`) → `DEFAULT_TEMPLATE_IDS.PRIVATE_LOAN_STATEMENT`
- Telugu (`rvp_private_loan_statement_telugu`): Fast2SMS message_id **28935** (Meta template ID `1537970847529214`) → `LANGUAGE_TEMPLATE_IDS.TE.PRIVATE_LOAN_STATEMENT`
- Hindi (`rvp_private_loan_statement_hindi`): Fast2SMS message_id **28936** (Meta template ID `1450108000273720`) → `LANGUAGE_TEMPLATE_IDS.HI.PRIVATE_LOAN_STATEMENT`

Which language a given loan sends in is set per-loan on the Add Loan dialog
(`PrivateLoan.waLanguage`) — English until changed, same UX as
`Party.waLanguage`. If a language's copy isn't approved yet (e.g. Tamil/Kannada),
the send falls back to the English copy automatically (the standard ERP-wide rule —
see `docs/whatsapp-multilingual-templates.md`).

## Template name

`rvp_private_loan_statement` (no header, category Utility — same shape as
`payment_reminder` and `rvp_reminder`)

## Variable contract — 6 vars, same order in every language

| Slot | Value | Example |
| --- | --- | --- |
| `{{1}}` | Borrower name | `Ramesh Kumar` |
| `{{2}}` | Outstanding principal (₹, `fmtInr`) | `2,00,000` |
| `{{3}}` | Interest rate **+ period, one string** (see below) | `12% p.a.` or `1% p.m.` |
| `{{4}}` | As-on date (`fmtDate`) | `15-Aug-2026` |
| `{{5}}` | Interest accrued to date (₹, `fmtInr`) | `9,863` |
| `{{6}}` | Total payable = outstanding + accrued interest (₹, `fmtInr`) | `2,09,863` |

Matches `sendPrivateLoanStatement` in
`server/src/services/whatsapp.service.ts`. No newlines in any variable — see
`docs/whatsapp-payment-reminder-templates.md` for why a newline inside a
template variable gets a message accepted by Fast2SMS but silently dropped by
WhatsApp.

### `{{3}}` — rate and period are entered per loan, not fixed in the template

Each `PrivateLoan` carries its own `interestPeriod` (`ANNUAL` or `MONTHLY`,
picked on the Add Loan dialog next to the rate field, `ANNUAL` by default).
The engine and the DB always store an **annual** rate (`interestRatePct`);
`interestPeriod` only controls how it's displayed - both on the Private Loans
page and in this message.

Because the period can differ loan to loan, the fixed template text can't
hardcode "% p.a." - a monthly-rate loan would read wrong. Instead
`formatRateLabel()` in `server/src/controllers/privateLoan.controller.ts`
builds the **whole** "12% p.a." / "1% p.m." string server-side, in the loan's
own language, and that whole string is what fills `{{3}}`. This is the same
technique already used for `REMINDER`'s lorry/lorries word
(`LORRY_WORDS` in `whatsapp.controller.ts`) - a single word/phrase
translated inside one variable slot, so one approved template still covers
every period and every language without doubling the Meta submissions.

`RATE_PERIOD_LABELS` (in `privateLoan.controller.ts`) holds the period word
per language:

| Language | Annual | Monthly |
| --- | --- | --- |
| EN | `p.a.` | `p.m.` |
| TE | `వార్షికం` | `నెలవారీ` |
| HI | `वार्षिक` | `मासिक` |

So the template body itself just prints `{{3}}` bare, with no fixed
"% p.a." suffix of its own - see the bodies below.

Sample values for the approval form: `Ramesh Kumar`, `2,00,000`,
`12% p.a.`, `15-Aug-2026`, `9,863`, `2,09,863`.

## Why it reads as a reminder, not a demand

The opening line says explicitly that this is a routine update on the
pending balance, not a call to act immediately — same friendly register as
`rvp_reminder` ("Gentle reminder … pending tamarind seed loads"). The figures
still need to be complete and accurate (outstanding, rate, accrued interest,
total), but the framing is informational.

## Why cash-basis, not accrual

Unlike `BankLoan` (money the business borrows, where interest is capitalised
into stock cost and only settles a payable on repayment), a `PrivateLoan` is
money the business lends out. Interest here is real income, recognised in the
books only when actually collected (`LedgerService.postPrivateLoanRepayment`
credits `40130 Interest Income`). The WhatsApp statement's "interest accrued"
figure is a live, non-posted estimate — it exists to tell the borrower what
they owe today, not to record anything in the ledger. Nothing is booked until
a repayment is actually entered.

## Bodies

**EN**
```
🙏 Namaste {{1}},

📢 This is a gentle reminder about your loan from *RVP INDUSTRIES* — just an update on the pending amount, no immediate action needed.

💰 Outstanding Principal: *₹{{2}}*
📊 Interest Rate: *{{3}}*
📅 Interest Accrued (as on {{4}}): *₹{{5}}*
🧾 Total Payable: *₹{{6}}*

Please arrange repayment at your convenience. Thank you.
*RVP INDUSTRIES*
*PUNGANUR*
```

**TE — తెలుగు**
```
🙏 నమస్తే {{1}},

📢 ఇది *RVP INDUSTRIES* నుండి తీసుకున్న మీ రుణానికి సంబంధించిన మర్యాదపూర్వక గుర్తుచేత — పెండింగ్‌లో ఉన్న మొత్తంపై ఒక అప్‌డేట్ మాత్రమే, వెంటనే ఏమీ చేయవలసిన అవసరం లేదు.

💰 మిగిలిన అసలు మొత్తం: *₹{{2}}*
📊 వడ్డీ రేటు: *{{3}}*
📅 సంచిత వడ్డీ ({{4}} నాటికి): *₹{{5}}*
🧾 మొత్తం చెల్లించవలసినది: *₹{{6}}*

దయచేసి మీ వీలును బట్టి తిరిగి చెల్లించండి. ధన్యవాదాలు.
*RVP INDUSTRIES*
*PUNGANUR*
```

**HI — हिंदी**
```
🙏 नमस्ते {{1}},

📢 यह *RVP INDUSTRIES* से लिए गए आपके ऋण के संबंध में एक सामान्य याद दिलाना है — बकाया राशि पर एक अपडेट मात्र है, तुरंत किसी कार्रवाई की आवश्यकता नहीं है।

💰 बकाया मूलधन: *₹{{2}}*
📊 ब्याज दर: *{{3}}*
📅 अर्जित ब्याज ({{4}} तक): *₹{{5}}*
🧾 कुल देय राशि: *₹{{6}}*

कृपया अपनी सुविधानुसार भुगतान की व्यवस्था करें। धन्यवाद।
*RVP INDUSTRIES*
*PUNGANUR*
```

Amounts, the date and the borrower's name stay in Latin script / Western
digits inside every translated body — this is the ERP-wide rule (see "What
stays in Latin script, and why" in `docs/whatsapp-multilingual-templates.md`),
not a gap in the translation.
