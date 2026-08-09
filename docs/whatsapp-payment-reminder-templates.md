# Payment reminder — why the invoice list is one line

## The finding

Meta's Cloud API does not allow a **newline character inside a template
variable**.

A reminder that listed each due invoice on its own line was **accepted** by
Fast2SMS — logged `SENT` with a provider id — and then **dropped undelivered**
by WhatsApp, showing a red `!` in the chat (Vimal Industries, 7 invoices, 09:41
IST on 09-Aug-2026). The single-invoice reminder sent to the same number 34
minutes earlier delivered normally. The newlines were the only difference.

So the list goes out as **one comma-separated line**:

```
🧾 Invoices due: RVP/63/26-27 (₹1,75,279), RVP/64/26-27 (₹1,73,820)
```

WhatsApp wraps long text on the phone, so a big list still reads over several
lines — it just isn't one invoice per line.

This cannot be fixed by editing the approved template's wording, because the
line breaks would have to live in the **variable**, not the template body. The
only true one-per-line layout would need a separate approved template per
invoice count (`{{3}}`, `{{4}}`, `{{5}}` … each on its own line in the body),
which was considered and rejected as not worth the approval overhead.

## Current behaviour

`invoiceListText()` in `server/src/services/salesDues.service.ts`:

- one entry per invoice, `INVOICE (₹AMOUNT)`, joined with `, `
- **oldest due first** — the order you'd chase them in
- capped at 10, with a trailing `+N more` beyond that
- no newlines, ever

Used by both the manual "Payment Reminder" button on the Party Ledger and the
daily buyer-dues cron job, so both read the same. The dialog preview shows the
same string that goes out.

Template in use: `payment_reminder` (Fast2SMS message_id `26195`), three
variables — recipient name, outstanding amount, invoice list.

## Known gap

Fast2SMS is not sending us delivery-status callbacks — there is not one status
event in `WhatsAppLog`, which is why the failed Vimal message still shows as
`SENT` in the ERP with no reason recorded. The handler already exists
(`handleWhatsAppWebhook`, `status_update` branch); what is missing is the
callback URL registered on the Fast2SMS side. Until that is wired, a rejected
send looks identical to a delivered one in the app.
