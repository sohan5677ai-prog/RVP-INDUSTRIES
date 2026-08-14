# Broker brokerage-ledger statement

The Brokerage Report detail page's "WhatsApp Ledger" button
(`client/src/pages/BrokerageLedger.tsx`) sends a broker's full brokerage
statement for a chosen period as a PDF document header, with a five-figure
summary in the template body - the same mechanics as the party ledger's
`rvp_party_ledger` send. Built by `buildBrokerLedgerData`
(`server/src/services/brokerLedger.service.ts`) and rendered by
`renderBrokerLedgerPdf` (`server/src/lib/brokerLedgerPdf.ts`), fired from
`sendBrokerLedgerWhatsApp` (`server/src/controllers/whatsapp.controller.ts`)
via `POST /whatsapp/brokers/:brokerId/send-ledger`.

## No separate template - reuses `rvp_party_ledger`

`sendBrokerLedgerStatement` (`server/src/services/whatsapp.service.ts`) sends
on the **`PARTY_LEDGER`** template key, not a dedicated `BROKER_LEDGER` one.
A broker's account posts exactly like a supplier's party ledger:

- **Brokerage credited** (one line per dispatch, at that broker's own
  `brokerageAmount` rate - configurable per broker, ₹2,000 by default) = a
  **Credit**, same as a supplier's purchases increasing what we owe them.
- **Payment made to the broker** = a **Debit**, same as paying a supplier
  reduces what we owe them.

So the approved `rvp_party_ledger` template's five slots (name, period, total
debits, total credits, closing balance) already say exactly the right thing
for a broker statement with no wording changes - `totalPaid` fills the "Total
Debits" slot, `totalBrokerage` fills "Total Credits". This means the send
works the moment `FAST2SMS_TMPL_PARTY_LEDGER` (or `DEFAULT_TEMPLATE_IDS.PARTY_LEDGER`
in `whatsapp.service.ts`) is set - no new Fast2SMS/Meta submission or
approval wait, unlike every other "not yet approved" template in this file.

`WhatsAppLog` rows from this send still carry `relatedType: 'BROKER_LEDGER'`
(set in `sendBrokerLedgerStatement`), so the two sends stay distinguishable
in the log even though they share a template and a `template` column value
of `PARTY_LEDGER`.

## Where the numbers come from

`buildBrokerLedgerData(brokerId)` in `server/src/services/brokerLedger.service.ts`
- one `BROKERAGE` (credit) line per `SaleDispatch` under the broker's sale
orders at that broker's `brokerageAmount` rate, one `PAYMENT` (debit) line
per `Payment` row where `type === 'BROKER'` and `brokerId` matches, sorted
chronologically with a running balance. This is a server-side port of the
same computation
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
copy of `rvp_party_ledger` isn't approved yet), same resolution order as
every other template - see `templateId()` in `whatsapp.service.ts`.
