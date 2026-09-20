# Inbound WhatsApp Message Forwarding

When an external customer, party, driver, or contact types a message to the company's WhatsApp business number (+917207146094), Fast2SMS delivers the inbound webhook to `/webhooks/whatsapp`. The server identifies the sender and forwards the message to internal team members using the approved Fast2SMS template `inbound_whatsapp_message`.

## Approved Template Details

- **Template Name:** `inbound_whatsapp_message`
- **Template ID (Meta):** `1624358459270497`
- **Fast2SMS Message ID:** `31637`
- **Sender Number:** `+917207146094`
- **Category:** `Marketing`
- **Language:** `en`
- **Status:** APPROVED

Wired in `DEFAULT_TEMPLATE_IDS['INBOUND_MESSAGE']` and `DEFAULT_TEMPLATE_NAMES['INBOUND_MESSAGE']` in `server/src/services/whatsapp.service.ts`.
Environment variable override: `FAST2SMS_TMPL_INBOUND_MESSAGE`.

## Template Content

```text
📩 Inbound WhatsApp Message — RVP ERP
From: {{1}}
Time: {{2}}

Message:
{{3}}

PLS GO REPLY TO THIS MESSAGE
```

| Slot | Content | Example |
|------|---------|---------|
| `{{1}}` | Sender identity (Party name, Broker name, Driver, or phone) | `Balaji Agro (9876543210)` |
| `{{2}}` | Timestamp in IST (`DD-MMM-YYYY HH:mm AM/PM`) | `20-Sep-2026 02:15 PM` |
| `{{3}}` | Inbound message text & media description | `Please send the payment receipt copy` |

## Webhook Routing Flow

1. Fast2SMS delivers an `incoming_message` payload to `POST /webhooks/whatsapp`.
2. `recordInboundMessage` logs the inbound message in `WhatsAppLog` (`direction: INBOUND`, `status: RECEIVED`). Duplicate `wamid` IDs are dropped.
3. If the message is an owner kata command (`APPROVE`, `STATUS`, `REJECT`, `HELP`), `processOwnerKataCommand` handles it and replies to the owner.
4. If the message contains an active driver weighbridge slip image, `processDriverKataInbound` runs Gemini OCR and notifies owners with the delivery review card.
5. Otherwise (any customer, party, broker, transporter, or external message):
   - `parseInboundIntoRegister` checks if it matches a lorry transport booking.
   - `notifyInboundMessageToMembers` runs:
     - Checks `prisma.party` (by phone or phone2) to match customer/party name.
     - Checks `prisma.broker` to match broker name.
     - Checks `prisma.saleDispatch` to match driver name.
     - Formats current IST timestamp.
     - Resolves internal team numbers from `CompanyProfile.alertRecipients` (and owner numbers).
     - Dispatches template `INBOUND_MESSAGE` (`31637`) to each internal member.
