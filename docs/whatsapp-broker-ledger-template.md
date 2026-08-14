# Broker brokerage-ledger statement

A new WhatsApp send for the Brokerage Report detail page's "WhatsApp Ledger"
button (`client/src/pages/BrokerageLedger.tsx`), mirroring the party ledger's
`rvp_party_ledger` send exactly: the broker's full brokerage statement for a
chosen period goes out as a PDF document header, with a five-figure summary
in the approved template body. Built by `buildBrokerLedgerData`
(`server/src/services/brokerLedger.service.ts`) and rendered by
`renderBrokerLedgerPdf` (`server/src/lib/brokerLedgerPdf.ts`), fired from
`sendBrokerLedgerWhatsApp` (`server/src/controllers/whatsapp.controller.ts`)
via `POST /whatsapp/brokers/:brokerId/send-ledger`.

## Not yet approved

`BROKER_LEDGER` has no Fast2SMS `message_id` yet - it needs to be submitted
and approved the same way `rvp_party_ledger` was. Until an id is set (via
`FAST2SMS_TMPL_BROKER_LEDGER` or `DEFAULT_TEMPLATE_IDS` in
`server/src/services/whatsapp.service.ts`), every send logs `SKIPPED` in
`WhatsAppLog` and nothing goes out - the button, dialog and PDF are wired and
idle, waiting on the id. Once approved, also add the
`FAST2SMS_TMPL_BROKER_LEDGER` row (`sync: false`) already present in
`render.yaml`.

## Template to submit on Fast2SMS

Name: `rvp_broker_ledger`. Category: **Utility**. Language: **English**.
**Document header** (the statement PDF attaches here - Meta rejects the send
if the media is missing, same as `rvp_party_ledger`).

```
📄 *{{1}}* - Brokerage Statement

Period: {{2}}
Total Brokerage: {{3}}
Total Paid: {{4}}
*Closing Balance: {{5}}*

Full statement attached above.
```

| Slot | Content | Example |
|------|---------|---------|
| `{{1}}` | Broker's name | `Suresh Traders` |
| `{{2}}` | Date range covered by the statement | `01-Apr-2026 to 14-Aug-2026` |
| `{{3}}` | Sum of brokerage credited in the period (₹2,000 flat per dispatch) | `₹1,24,000` |
| `{{4}}` | Sum of BROKER-type payments made in the period | `₹96,000` |
| `{{5}}` | Closing balance with Dr/Cr marker (Cr = still payable by us) | `₹28,000 Cr` |

Five variables, all short numeric/date strings - no free text and no
newlines in any slot, matching the same constraint `rvp_party_ledger` sits
under (template variables cannot contain line breaks, which is why the
opening balance and the full voucher list live only in the attached PDF).

## Where the numbers come from

`buildBrokerLedgerData(brokerId)` in `server/src/services/brokerLedger.service.ts`
- one `BROKERAGE` (credit) line per `SaleDispatch` under the broker's sale
orders at the flat ₹2,000 rate, one `PAYMENT` (debit) line per `Payment` row
where `type === 'BROKER'` and `brokerId` matches, sorted chronologically with
a running balance. This is a server-side port of the same computation
`BrokerageLedger.tsx`'s `allTxns` already does client-side for the on-page
table, so the WhatsApp figures, the PDF and the page agree to the rupee.

The "RVP" own-orders marker broker is excluded from this send (see
`isOwnBroker` in `brokerLedger.service.ts`) - there is no real brokerage to
report and typically no phone on file for it.

## Where it goes

The broker's own `phone` (or a one-off number typed into the dialog), with
the office copied on the identical statement PDF via the same
`sendToPartyAndInternal` internal-copy mechanism every other party/broker
send uses.

## Language

Sent in the broker's `waLanguage` (falling back to English if that language's
copy isn't approved yet), same resolution order as every other template - see
`templateId()` in `whatsapp.service.ts`. No translated copies exist yet;
add them the same way `PARTY_LEDGER`'s translations were added, if ever
needed.
