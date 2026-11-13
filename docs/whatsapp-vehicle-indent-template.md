# Vehicle requirement (day indent) → transporter

The loading calendar's outbound message: *"these are the lorries I need from
you on this date"*. One message per transporter per **day**, not per sale
order — a transport office plans by tomorrow's fleet, so an order shipping on
the 16th, 18th and 20th appears in three different day messages, each
alongside whatever else loads that day.

## Status: not submitted

**No Fast2SMS template exists for this yet**, so the ERP does not send it
through `whatsappService`. Instead `POST /api/dispatch-slots/indent` returns
the rendered text and the Loading Calendar opens `wa.me` with it pre-filled,
out of the user's own WhatsApp. That is deliberate for Phase 1:

- the message is free-form and changes shape with the day (one lorry or six,
  one loading point or two), which fits a conversation better than a
  fixed-slot template;
- it lands in the same thread the transporter already replies into, which is
  where his lorry numbers come back from;
- it needs no Meta approval cycle to start being useful.

The slots are still marked `REQUESTED` server-side when the user presses send,
so "asked for but not yet confirmed" remains a state the calendar can show and
chase — the record does not depend on the delivery channel.

## Rendered message

Built by `buildIndentMessage` in `server/src/services/dispatchSlot.service.ts`.

```
*RVP INDUSTRIES - Vehicle Requirement*
16-NOV (Mon)

16NOV-01 - 30 t to Surat
16NOV-02 - 25 t to Surat
16NOV-03 - 25 t to Barshi

Total: 3 lorries · 80 t

Please reply with the lorry number and driver details against each code.
```

A day that loads at both points splits the list under `Loading at RVP:` /
`Loading at KNM:` headings. A re-send is headed `(REVISED)` and shows any
lorry already confirmed in square brackets after its line, so the transporter
can see what has and has not moved.

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
