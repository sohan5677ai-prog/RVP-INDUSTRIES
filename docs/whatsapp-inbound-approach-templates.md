# Arriving lorry → the team (`inbound_approach_alert`, `inbound_hamali_ready`)

The two messages that go out when a booked **inbound purchase lorry** crosses
the approach ring — ten km from the factory by default. The office gets the
detail, the hamali team gets the warning.

The mirror of [`inbound_driver_brief`](./whatsapp-inbound-driver-brief-template.md),
which goes to the driver the moment the booking lands. This pair goes to *us*,
hours later, when he is nearly here.

**Two templates to create** (plus the Hindi copy of the second). Both are plain
Utility bodies with **no header**, so unlike the driver brief they send over the
cheap numeric `message_id` GET path — much less to go wrong.

## Why only one ring messages anyone

| Ring | Default | What happens |
|---|---|---|
| **Approach** | 10 km | These two WhatsApps go out |
| **Gate** | 3 km | The kata cabin raises its ticket. **No message.** |

The office needs the weighbridge and the paperwork free, and the hamali team
needs fifteen or twenty minutes to assemble — ten km of this road is about that.
Three km is four minutes: nobody can act on a message at that point, and a
second alert for the same lorry is how an alert channel stops being read. The
cabin's arrivals strip is the whole of the gate ring's output.

Both rings are configurable in **Settings → Company Details** (`inboundApproachRingKm`,
`inboundGateRingKm`), because the right distance is a function of the road.

---

## 1. `inbound_approach_alert` — the internal team

| Field | Value |
|---|---|
| Name | `inbound_approach_alert` |
| Category | **Utility** |
| Language | **English** |
| Header | none |
| Body | 7 variables, below |
| Footer / Buttons | none |

Goes to the internal alert list — `CompanyProfile.alertRecipients`, the same up-to-three
name+number list the dues digest uses, falling back to `ownerWhatsappNumber`.

### Body

```
RVP Industries - arriving lorry.

Lorry: {{1}}
Supplier: {{2}}
Load: {{3}}
Distance: {{4}} km away
Expected at gate: {{5}}
Driver: {{6}}
Requirement: {{7}}

Please keep kata and unloading ready.
```

| # | What it is | Sample for approval |
|---|---|---|
| `{{1}}` | Lorry number, normalised | `GJ18BV5741` |
| `{{2}}` | Supplier party name, off the purchase order | `Shree Traders` |
| `{{3}}` | Product and tonnage | `Black seed - 35.00 MT` |
| `{{4}}` | Distance — **bare number** | `9` |
| `{{5}}` | ETA in IST | `today 3:40 PM` |
| `{{6}}` | Driver mobile, from the transporter's message | `9050306685` |
| `{{7}}` | Requirement code | `16NOV-02` |

`{{4}}` carries **just the number**. The body already reads "Distance: {{4}} km
away", so `9.4 km` there would print `9.4 km km` — the same static-label trap
`SALE_ORDER_CONFIRMED` documents, where `25.00 MT` in a `{{4}} MT` slot printed
`25.00 MT MT`.

---

## 2. `inbound_hamali_ready` — the unloading team

| Field | Value |
|---|---|
| Name | `inbound_hamali_ready` |
| Category | **Utility** |
| Language | **Hindi** first, then English |
| Header | none |
| Body | 4 variables |
| Footer / Buttons | none |

Goes to the `HAMALI_TEAM` party's phone — the same party the driver brief quotes
as the unloading contact, so there is one number to keep current.

### Body — Hindi copy

```
नमस्ते।

लॉरी {{1}} फैक्ट्री पहुँचने वाली है।

माल: {{2}}
सप्लायर: {{3}}
ड्राइवर: {{4}}

कृपया अनलोडिंग के लिए तैयार रहें।
```

### Body — English copy

Same four variables in the same order. Meta approves one template per language,
each under its own name, and the ERP picks by language at send time —
`notifyInboundApproach` asks for `HI` and falls back to the English copy until
the Hindi one is approved, so nothing is held up waiting for it.

```
Namaste.

Lorry {{1}} is about to reach the factory.

Load: {{2}}
Supplier: {{3}}
Driver: {{4}}

Please be ready for unloading.
```

| # | What it is | Sample for approval |
|---|---|---|
| `{{1}}` | Lorry number | `GJ18BV5741` |
| `{{2}}` | Product and tonnage | `Black seed - 35.00 MT` |
| `{{3}}` | Supplier party name | `Shree Traders` |
| `{{4}}` | Driver mobile | `9050306685` |

---

## Meta's three body rules

Both bodies above satisfy all three — keep them satisfied if you reword:

1. The body may not **begin or end** with a variable.
2. Two variables may not sit **side by side**.
3. A variable's **value** may not contain a newline. (This is what bit
   `VEHICLE_INDENT`, whose whole fleet had to become one pipe-separated line.)

## Env

Both are numeric-`message_id` templates. Set the ids Fast2SMS shows under
**Message ID** — not the Meta template ID, which 400s with "Template ID
(message_id) is invalid or not approved":

```
FAST2SMS_TMPL_INBOUND_APPROACH_OFFICE=<message_id>
FAST2SMS_TMPL_INBOUND_APPROACH_HAMALI=<message_id of the English copy>
FAST2SMS_TMPL_INBOUND_APPROACH_HAMALI_HI=<message_id of the Hindi copy>
```

Nothing is baked into `DEFAULT_TEMPLATE_IDS` for these, deliberately: an id
there that was never approved would send and fail on every arriving lorry.

## Until they are approved

A ring that fires with no template configured still latches. That is the
intended behaviour, not a gap — `ApproachAlert` exists precisely so that a lorry
parked at 9.8 km does not re-announce itself every two minutes, and re-arming
the ring on a failed send would re-create exactly that. The row records
`notifiedCount: 0`, the sends log `SKIPPED` in `WhatsAppLog` against
`relatedType: 'INBOUND_APPROACH'`, and the **Upcoming Vehicles** tab still shows
the lorry, its distance and which rings it crossed.

With `WHATSAPP_TEST_MODE` on (the default), the whole path can be walked with a
real lorry against the owner's own number first.
