# Dispatch → driver WhatsApp (`driver_industries`)

The message the lorry driver gets when a dispatch is created, and again from
**Resend to driver** on the dispatch row. Approved 2026-08-12, message_id
`28540`, on the shared KNM number (+91 7207146094).

It replaced `rvp_driver`, which was deleted at Meta's end; while it was gone the
`DISPATCH_DRIVER` key deliberately carried no id at all, so every driver send
logged a clean `SKIPPED — not configured` in `WhatsAppLog` rather than a
`FAILED` that looked like an outage.

## It has a LOCATION header — that changes the send path

The template opens with a WhatsApp **location card** (pin, `{{Location name}}`,
`{{Address}}`) above the body text. Two consequences, both load-bearing:

1. **The numeric message_id is useless here.** Fast2SMS's simple
   `variables_values` GET send has no way to fill a header, so the driver
   message goes over the Meta-format POST endpoint, which addresses templates by
   **name**. `DISPATCH_DRIVER: 'driver_industries'` lives in
   `DEFAULT_TEMPLATE_NAMES` (`server/src/services/whatsapp.service.ts`), *not* in
   `DEFAULT_TEMPLATE_IDS`. `FAST2SMS_TMPL_DISPATCH_DRIVER` on Render is inert —
   harmless, but it is not what makes the send work.
2. **Every send needs real coordinates.** Meta rejects a template whose declared
   header has no parameter, and there is no plain-text driver template left to
   fall back to. No pin ⇒ no message.

The POST send also needs `FAST2SMS_PHONE_NUMBER_ID` to point at the number the
template is approved under, or Fast2SMS answers `404 Template not found.` — the
`/webhooks/whatsapp/jobs/check-driver-template` diagnostic prints which number
owns the name.

## Where the pin comes from

`Party.locationLink` on the buyer, resolved by
`server/src/lib/mapsLink.ts` — no Maps API key, it just follows the share link
and reads coordinates out of the final URL, the way a browser does.

| Stored value | Resolves? |
|---|---|
| `21.132722, 72.833611` (plain coordinates) | yes, no network call |
| `.../maps/place/x/@21.1325133,72.8326854,17z` | yes, no network call |
| `maps.app.goo.gl/...` that redirects to an `@lat,lng` URL | yes, one redirect |
| `maps.app.goo.gl/...` for a **business listing** | **no** — see below |

A business-listing link redirects to `place/Hari+Om+Gum+Industries/data=!4m2!3m1!1s0x3be0...`:
a place id, with the coordinates nowhere in the URL or the page body. As of
2026-08-12 that is 5 of the 10 dispatch buyers who have a link saved (10 of 20
buyers have one at all).

**The fix is data entry, not code**: long-press the spot in Google Maps, tap the
`lat, lng` numbers it shows to copy them, and paste those into the party's
location field. The field takes bare coordinates directly, and the driver still
gets a tappable link in `{{7}}` because `mapsUrlFor` wraps them into a maps URL.

A buyer whose location can't be resolved is logged `SKIPPED` against the
dispatch, naming the buyer and what to do about it. That is deliberate: a driver
sent to a guessed pin (say, his destination town's centre) is worse off than one
who got no message.

If the half-coverage becomes a problem before the location fields are filled in,
the way out is a second approved template with **no header** and the same seven
variables — the old `rvp_driver` shape — sent when coordinates are missing.
That is a Fast2SMS approval plus a small branch in `notifyDispatchDriver`.

## The seven body variables

| Slot | Content | Example |
|------|---------|---------|
| `{{1}}` | Driver name (falls back to `Driver ji`) | `Venkatesh` |
| `{{2}}` | Lorry number | `TS16UB4567` |
| `{{3}}` | Deliver to — buyer name | `Hariom Gum Industries` |
| `{{4}}` | Destination — order's, else buyer's city | `Surat` |
| `{{5}}` | Load — product and weight | `PAPPU - 25.00 MT` |
| `{{6}}` | Party contact | `9876543210` |
| `{{7}}` | Maps link | `https://maps.google.com/?q=11.237543,77.55936` |

The header's own two caption slots — `{{Location name}}` and `{{Address}}` — are
sent **empty on purpose**. Meta has both optional, and filling them changes what
a tap on the pin does: the map app looks up those strings instead of opening the
coordinates. The first live send carried "Colourtex Industries Private Ltd" /
"Unit - 6, Plot No.294/10, G.I.D.C, Pandesar…" and tapping the pin offered a
list of candidates rather than the gate. With coordinates alone there is nothing
to search, so the pin opens where it was dropped. The driver loses no
information: `{{3}}` and `{{4}}` right below the card name the buyer and the town.

`{{7}}` is **not** whatever was pasted into the party form. Once the
coordinates are known the link is rebuilt as a short `?q=lat,lng` — a copied
Google Maps place URL runs past 300 characters and wrapped over eight lines in
the driver's message, pushing the lorry number and load off his first screen.
Only a share link that could not be resolved is passed through as stored, and
those buyers are skipped anyway.

Destination is spelled out in `{{4}}` even though the pin says it too — the
location card is easy to scroll past, and a driver who has the town in text can
read it out to someone.

## Testing without messaging a real driver

`server/prisma/testDriverWhatsapp.ts` picks the most recent dispatch with a
driver phone, points WhatsApp test mode at a number you pass, and sends. It
needs the Fast2SMS env vars, so run it from the Render shell:

```bash
npx tsx prisma/testDriverWhatsapp.ts 8019965187
```

It leaves test mode **on** and pointed at that number — switch it back in
Settings → WhatsApp afterwards, or every other message keeps landing there.
