# Vehicle requirement (day indent) → transporter

The loading calendar's outbound message: *"these are the lorries I need from
you on this date"*. One message per transporter per **day**, not per sale
order — a transport office plans by tomorrow's fleet, so an order shipping on
the 16th, 18th and 20th appears in three different day messages, each
alongside whatever else loads that day.

## Status: submitted, awaiting approval

Drafted and submitted to Fast2SMS as `rvp_vehicle_requirement` (body below);
**no approved message id yet**, so the ERP does not send it through
`whatsappService`. Until it has one, `POST /api/dispatch-slots/indent` returns
the rendered text and the Loading Calendar opens `wa.me` with it pre-filled,
out of the user's own WhatsApp. Two things make that an acceptable Phase 1
rather than a stopgap:

- it lands in the same thread the transporter already replies into, which is
  where his lorry numbers come back from;
- the slots are still marked `REQUESTED` server-side when the user presses
  send, so "asked for but not yet confirmed" stays a state the calendar can
  show and chase regardless of the delivery channel.

### Wiring it once approved

Add `VEHICLE_INDENT` to `WaTemplateKey`, its message id to
`DEFAULT_TEMPLATE_IDS` (overridable with `FAST2SMS_TMPL_VEHICLE_INDENT`), and a
`sendVehicleIndent` that passes
`variables: [transportName, dateLabel, vehiclesLine]` - the three values
`buildIndentVariables` already returns, so nothing needs re-deriving. Keep the
`wa.me` path as the fallback for an unset or rejected id, the way
`PAYMENT_SENT` falls back to `PAYMENT_SENT_TEXT`.

## Template as submitted to Fast2SMS

Name: `rvp_vehicle_requirement`. Category: **Utility**. Language: **English**.
No header, no buttons. Three variables.

```
Dear {{1}},
Please arrange the following vehicles.

Loading date: *{{2}}*

Vehicles: {{3}}

Kindly reply with the lorry number, driver name and driver mobile against each code.
```

| Slot | Content | Example |
|------|---------|---------|
| `{{1}}` | Transporter name | `Surya Road Lines` |
| `{{2}}` | Loading date, with ` (REVISED)` appended on a re-send | `16-Nov-2026 (Mon)` |
| `{{3}}` | The whole fleet, pipe-separated on ONE line | `16NOV-01 30t Pappu RVP to Surat \| 16NOV-02 25t Husk KNM to Barshi` |

`(REVISED)` goes inside `{{2}}` rather than into a second template - a re-send
is the same message about the same day, and submitting `rvp_vehicle_requirement_revised`
for one word would double the approval surface for nothing.

### Why the fleet is one line

Meta drops any template variable containing a newline (the same constraint
`salesDues.service.dueTodayListText` is written around). So `{{3}}` cannot be a
block, however much easier that would be to read. Entries are separated by
` | ` rather than commas: on a phone a comma-joined list runs together as one
sentence and the eye loses where each lorry begins.

Six lorries come to roughly 300 characters, against a 1024 limit with the body
at ~180 - so unlike the dues digest there is no need to cap the list or append
"+N more".

### Why loading point and commodity sit inside each entry

Both vary per lorry. One day can load at RVP and at KNM, carrying pappu for one
buyer and husk for another. Hoisting either to a message-level line
(`Loading point: RVP`) would be wrong the first time a day mixed them, and the
failure is expensive - a lorry sent to the wrong gate. Inside the entry they
cost no extra variable.

The commodity earns its place because 25 t of husk needs far more body volume
than 25 t of pappu: a transporter who is not told the commodity can send a
lorry that physically will not take the load.

### What is deliberately absent

**The buyer.** A transporter needs the day, the size, the commodity and the two
places. Who bought the goods is ours, and the ERP sends this from a WhatsApp
number shared with KNM, so naming the buyer would be a leak rather than a
courtesy. Rate, invoice value, broker and order reference are out for the same
reason - none of them helps him send a lorry.

One residual risk: the destination falls back to the buyer's **city** when an
order has no destination set, and `SaleOrder.destination` is free text. An
order with a buyer's *name* typed into that field would carry it through. The
field is worth keeping clean.

### Rendered message

`buildIndentVariables` in `server/src/services/dispatchSlot.service.ts` builds
the three values; `buildIndentMessage` composes them into exactly the body
above for the wa.me send, so what the transporter reads today is
character-for-character what the template will send once approved.

```
Dear Surya Road Lines,
Please arrange the following vehicles.

Loading date: *16-Nov-2026 (Mon)*

Vehicles: 16NOV-01 30t Pappu RVP to Surat | 16NOV-02 25t Husk KNM to Barshi

Kindly reply with the lorry number, driver name and driver mobile against each code.
```

A lorry already confirmed shows its number in square brackets after its entry,
so a revision reads as a change rather than a repeat.

### Optional additions, not submitted

- **A bold title line** (`*Vehicle Requirement*`) above the greeting. Costs no
  variable and makes the message findable when the transporter scrolls back
  through a week of chat.
- **A signature line.** The sending number is shared with KNM, so without one
  the transporter has only the greeting to tell him whose requirement this is.
- **Reporting time** and **a gate contact**, as a fourth and fifth variable.
  Worth adding once the first version is approved and in daily use.
- **A location link** for the loading point (`lib/mapsLink.ts`). Left out of v1
  because Meta treats URL variables more strictly; the driver already gets one
  in the dispatch message.

## The slot code

`16NOV-03` — day, month, and the slot's sequence within that day. It is the
whole reason a reply can be matched to one lorry instead of guessed at from
route + date + tonnage, so three rules hold:

1. **The code always matches the slot's own loading day.** Moving a lorry to
   another date re-numbers it (`12NOV-01` → `13NOV-01`); the sequence is
   unique per date, so carrying the old number across would also collide.
2. **A number is never reused.** A cancelled slot keeps its place in the day's
   sequence — the transporter already has that code on his phone, and must
   never receive a second lorry under it.
3. **A moved slot that had been asked for drops back to `PLANNED`**, so the
   day's indent is sent again and he learns the lorry has shifted.

## If it is ever templated

The variable part is the list, which has no fixed length — so a template would
need the whole body in one variable (as `OWNER_DUE_TODAY_DIGEST` does with its
itemised list) rather than a slot per lorry. Three variables would do it:
transporter name, date label, and the rendered list plus total.
