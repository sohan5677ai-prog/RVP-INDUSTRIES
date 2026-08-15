# Private loan statement — drafted templates (EN / TE / HI)

## Status

**Not yet submitted to Meta.** `PRIVATE_LOAN_STATEMENT` has no Fast2SMS
`message_id` configured (see `DEFAULT_TEMPLATE_IDS` / `LANGUAGE_TEMPLATE_IDS`
in `server/src/services/whatsapp.service.ts`), so every send from the Private
Loans page's "Send Statement" button logs `SKIPPED` in `WhatsAppLog` until
one is set. Submit the three bodies below on the Fast2SMS WhatsApp panel
(same shared KNM number used by every other template), wait for Meta
approval, then wire the ids:

- English → `DEFAULT_TEMPLATE_IDS.PRIVATE_LOAN_STATEMENT` (or
  `FAST2SMS_TMPL_PRIVATE_LOAN_STATEMENT` on Render for a no-deploy fix)
- Telugu → `LANGUAGE_TEMPLATE_IDS.TE.PRIVATE_LOAN_STATEMENT` (or
  `FAST2SMS_TMPL_PRIVATE_LOAN_STATEMENT_TE`)
- Hindi → `LANGUAGE_TEMPLATE_IDS.HI.PRIVATE_LOAN_STATEMENT` (or
  `FAST2SMS_TMPL_PRIVATE_LOAN_STATEMENT_HI`)

Which language a given loan sends in is set per-loan on the Add Loan dialog
(`PrivateLoan.waLanguage`) — English until changed, same UX as
`Party.waLanguage`. If a language's copy isn't approved yet, the send falls
back to the English copy automatically (the standard ERP-wide rule — see
`docs/whatsapp-multilingual-templates.md`).

## Proposed name

`rvp_private_loan_statement` (no header, category Utility — same shape as
`payment_reminder` and `rvp_reminder`)

## Variable contract — 6 vars, same order in every language

| Slot | Value | Example |
| --- | --- | --- |
| `{{1}}` | Borrower name | `Ramesh Kumar` |
| `{{2}}` | Outstanding principal (₹, `fmtInr`) | `2,00,000` |
| `{{3}}` | Interest rate, bare number (% p.a. is in the fixed text) | `12` |
| `{{4}}` | As-on date (`fmtDate`) | `15-Aug-2026` |
| `{{5}}` | Interest accrued to date (₹, `fmtInr`) | `9,863` |
| `{{6}}` | Total payable = outstanding + accrued interest (₹, `fmtInr`) | `2,09,863` |

Matches `sendPrivateLoanStatement` in
`server/src/services/whatsapp.service.ts`. No newlines in any variable — see
`docs/whatsapp-payment-reminder-templates.md` for why a newline inside a
template variable gets a message accepted by Fast2SMS but silently dropped by
WhatsApp.

Sample values for the approval form: `Ramesh Kumar`, `2,00,000`, `12`,
`15-Aug-2026`, `9,863`, `2,09,863`.

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
📊 Interest Rate: *{{3}}% p.a.*
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
📊 వడ్డీ రేటు: *{{3}}% p.a.*
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
📊 ब्याज दर: *{{3}}% प्रति वर्ष*
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
