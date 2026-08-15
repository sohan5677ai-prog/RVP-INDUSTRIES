# Private loan statement — drafted template

## Status

**Not yet submitted to Meta.** `PRIVATE_LOAN_STATEMENT` has no Fast2SMS
`message_id` configured (see `DEFAULT_TEMPLATE_IDS` in
`server/src/services/whatsapp.service.ts`), so every send from the Private
Loans page's "Send Statement" button logs `SKIPPED` in `WhatsAppLog` until one
is set. Submit the wording below on the Fast2SMS WhatsApp panel (same shared
KNM number used by every other template), wait for Meta approval, then set
the id via `FAST2SMS_TMPL_PRIVATE_LOAN_STATEMENT` (or hardcode it into
`DEFAULT_TEMPLATE_IDS`).

## Proposed name

`rvp_private_loan_statement`

## Proposed body (6 variables, no newlines)

```
Hello {{1}}, this is a statement of your loan from RVP. Outstanding principal: Rs.{{2}}. Interest rate: {{3}}% p.a. Interest accrued as on {{4}}: Rs.{{5}}. Total payable: Rs.{{6}}. Please arrange repayment at your convenience.
```

Rendered example:

```
Hello Ramesh, this is a statement of your loan from RVP. Outstanding principal: Rs.2,00,000. Interest rate: 12% p.a. Interest accrued as on 15-Aug-2026: Rs.9,863. Total payable: Rs.2,09,863. Please arrange repayment at your convenience.
```

Variable order, matching `sendPrivateLoanStatement` in
`server/src/services/whatsapp.service.ts`:

1. Borrower name
2. Outstanding principal (₹, Indian-grouped)
3. Interest rate (% per annum)
4. As-on date (dd-MMM-yyyy)
5. Interest accrued to date (₹)
6. Total payable = outstanding + accrued interest (₹)

No newlines in any variable — see
`docs/whatsapp-payment-reminder-templates.md` for why a newline inside a
template variable gets a message accepted by Fast2SMS but silently dropped by
WhatsApp.

## Why cash-basis, not accrual

Unlike `BankLoan` (money the business borrows, where interest is capitalised
into stock cost and only settles a payable on repayment), a `PrivateLoan` is
money the business lends out. Interest here is real income, recognised in the
books only when actually collected (`LedgerService.postPrivateLoanRepayment`
credits `40130 Interest Income`). The WhatsApp statement's "interest accrued"
figure is a live, non-posted estimate — it exists to tell the borrower what
they owe today, not to record anything in the ledger. Nothing is booked until
a repayment is actually entered.
