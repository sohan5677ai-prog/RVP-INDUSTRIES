# Booking → arriving driver (`inbound_driver_brief`)

The message the driver of an **inbound purchase lorry** gets the moment the
transporter's booking lands on WhatsApp quoting its requirement code: the
factory pin, what he is carrying, and the two numbers he will need at the gate.

The mirror of [`driver_industries`](./whatsapp-driver-template.md) pointed the
other way — that one sends an outbound driver the buyer's pin, this one sends an
inbound driver ours.

**One template to create** (plus its Hindi copy). The approach-ring alerts to the
office and the hamali team are not built yet, so their templates are not needed.

## Submit this

| Field | Value |
|---|---|
| Name | `inbound_driver_brief` |
| Category | **Utility** |
| Language | **Hindi** first, then English |
| Header | **Location** |
| Body | 7 variables, below |
| Footer | none |
| Buttons | none |

### Body — English copy

```
Namaste.

Lorry {{1}} is booked for RVP Industries.

Load: {{2}}
Loading from: {{3}}
Unloading at: {{4}}

Contact at the factory: {{5}}
Unloading (hamali) team: {{6}}

Factory location: {{7}}

Please call the factory contact before you reach.
```

### Body — Hindi copy

Same seven variables in the same order. Meta approves one template per language,
each under its own name, and the ERP picks by language at send time.

```
नमस्ते।

लॉरी {{1}} RVP Industries के लिए बुक हो गई है।

माल: {{2}}
लोडिंग: {{3}}
अनलोडिंग: {{4}}

फैक्ट्री संपर्क: {{5}}
हमाली टीम: {{6}}

फैक्ट्री लोकेशन: {{7}}

पहुँचने से पहले फैक्ट्री संपर्क पर कॉल करें।
```

### Variables, and the sample values to submit with

| # | What it is | Sample for approval |
|---|---|---|
| `{{1}}` | Lorry number, normalised | `GJ18BV5741` |
| `{{2}}` | Product and tonnage | `Black seed - 35.00 MT` |
| `{{3}}` | Loading place, in the transporter's own words | `Sahada-MH` |
| `{{4}}` | Unloading point — company name + town | `RVP INDUSTRIES, Punganur` |
| `{{5}}` | Gate contact, name + mobile | `Suresh 9876543210` |
| `{{6}}` | Hamali team, name + mobile | `Bikash and Team 9876543211` |
| `{{7}}` | Short maps link to the pin | `https://maps.google.com/?q=13.365871,78.588247` |

Meta rejects a body that begins or ends with a variable, or that puts two
variables side by side. The copy above satisfies all three — keep a line of text
around `{{7}}` if you reword it.

## Header: it is a LOCATION, and that changes the send path

Same two consequences as `driver_industries`, for the same reasons:

1. **The numeric `message_id` is useless here.** Fast2SMS's simple
   `variables_values` GET send cannot fill a header, so this goes over the
   Meta-format POST endpoint, which addresses templates by **name**.
   `INBOUND_DRIVER_BRIEF: 'inbound_driver_brief'` lives in
   `DEFAULT_TEMPLATE_NAMES` in `server/src/services/whatsapp.service.ts`, and
   deliberately **not** in `DEFAULT_TEMPLATE_IDS`. An id there would send the
   body with no header and fail the whole message on Meta's parameter count.
2. **`FAST2SMS_PHONE_NUMBER_ID` must be set**, pointing at the number the
   template is approved under, or Fast2SMS answers `404 Template not found.`

Unlike the buyer pin, this one can never fail to resolve: the coordinates are
the `FACTORY` constant in `server/src/lib/gpsPlaces.ts`
(13.3658707, 78.5882473), not a party's pasted share link. So there is no
skip-for-missing-pin path on this template.

The header's two caption lines are both mandatory on a location header. They are
filled with the company name and the **coordinates** rather than the street
address — tapping the card hands the map app those strings to look up, and a
mill on a village road comes back as a list of guesses.

## Env

Nothing is required: the name is baked into `DEFAULT_TEMPLATE_NAMES`. Override
only if Meta approves it under a different name.

```
FAST2SMS_TMPL_NAME_INBOUND_DRIVER_BRIEF=inbound_driver_brief
FAST2SMS_TMPL_NAME_INBOUND_DRIVER_BRIEF_HI=<name of the Hindi copy>
```

`templateName()` tries the `_HI` name first and falls back to the English one,
and `sendLocationWhatsAppTemplate` sends `language: { code: 'hi' }` only when a
Hindi name actually resolved — a Hindi template sent under `en` is "template not
found" at Meta, not an English message. So a booking filed before the Hindi copy
is approved goes out in English rather than failing.

## Until it is approved

Sends log `FAILED` in `WhatsAppLog` against `relatedType: 'INBOUND_BOOKING'`.
Nothing else is blocked — the register still files the booking, links it to its
purchase order and shows the **Brief driver** button. Only a successful send
stamps `driverBriefSentAt`, so every driver booked in the meantime can be briefed
with that button once the template lands.

With `WHATSAPP_TEST_MODE` on, the whole path can be exercised against the owner's
own number first.
