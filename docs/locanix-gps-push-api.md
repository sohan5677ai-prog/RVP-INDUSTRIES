# RVP Industries ERP — GPS Position Push API

> **Superseded.** Locanix shipped a *pull* API in the end, so the ERP polls them - see [locanix-gps-pull-api.md](locanix-gps-pull-api.md) for what is actually running. This webhook stays mounted and tested, and is the document to send a provider who prefers to push.

**Status:** built and live in the code (branch `security/phase-2-rbac`). Needs two things before it accepts real data: `GPS_PUSH_TOKEN` set on the Render service, and `npx prisma db push` run so the `VehiclePing` table exists.

This is the **reverse** of [locanix-gps-api-request.md](locanix-gps-api-request.md). That one asked Locanix for a *pull* API we would poll. Locanix has instead offered to **push** to us, which is better for us in every way: no credentials of theirs to hold, no polling job, no rate limits, and positions arrive as the device reports instead of up to 10 minutes late.

Sections 1–5 below are the part to send them. Section 6 is for us.

---

## 1. What Locanix needs to be told (one paragraph)

> Please POST each position reading to `https://rvp-server.onrender.com/api/webhooks/gps` as JSON, with the header `X-API-Key: <token we will send you separately>`. Body fields: `vehicleNumber`, `latitude`, `longitude`, `speed`, `address`, and `timestamp` if you have it. One reading per call or an array of readings per call — both work. We reply `200` with a count; anything other than `200` may be retried.

Everything after this is detail they may or may not need.

---

## 2. Endpoint

| | |
|---|---|
| **URL** | `https://rvp-server.onrender.com/api/webhooks/gps` |
| **Method** | `POST` |
| **Content-Type** | `application/json` |
| **Auth** | `X-API-Key: <token>` header |
| **Probe** | `GET` on the same URL returns `{"ok":true,...}` — for URL validation in their panel |

HTTPS only. No IP whitelisting on our side, so nothing breaks if they change servers.

### Authentication

The token goes in **any one** of these, whichever their platform supports:

```
X-API-Key: <token>
Authorization: Bearer <token>
X-Gps-Token: <token>
```

As a last resort it is also read from `?token=<token>` on the URL — but a token in a URL gets written into access logs at both ends, so a header is strongly preferred.

The token is sent to them out of band (not in the same email as this document). Without it, or with a wrong one, the endpoint returns `401` and stores nothing.

---

## 3. Request body

### Fields

| Field | Required | Type | Notes |
|---|---|---|---|
| `vehicleNumber` | **yes** | string | The plate, e.g. `GJ18BV6551`. Spaces, hyphens and lower case are all fine — we normalise. |
| `latitude` | **yes** | number | Decimal degrees. A string like `"16.2000"` is accepted. |
| `longitude` | **yes** | number | Decimal degrees. |
| `speed` | no | number | km/h. |
| `address` | no | string | Nearest location / landmark text, as their platform reverse-geocodes it. |
| `timestamp` | no | string/number | When the device recorded the fix. If omitted we stamp the time the call arrived. |
| `ignition` | no | bool/string | `true/false`, `1/0`, `ON/OFF` — all understood. Optional extra, not requested. |

Anything else in the body is stored as-is and ignored, so they can send their full payload unchanged.

### Field names are flexible

We accept each field under the names vendors commonly use, case-insensitively and ignoring `_`/`-`/spaces. So `vehicle_no`, `VehicleNo`, `vehicleNumber` and `regNo` are all read as the vehicle number. This is deliberate: **they do not need to rename anything to match us.**

| Field | Also accepted as |
|---|---|
| `vehicleNumber` | `vehicle_no`, `vehicleNo`, `vehicle`, `regNo`, `registrationNumber`, `vehicleRegNo`, `truckNo`, `lorryNo`, `plateNumber`, `imei` |
| `latitude` | `lat` |
| `longitude` | `lng`, `lon`, `long` |
| `speed` | `speedKmph`, `speedKmh`, `currentSpeed` |
| `address` | `location`, `nearestLocation`, `landmark`, `place`, `area` |
| `timestamp` | `time`, `dateTime`, `deviceTime`, `gpsTime`, `fixTime`, `lastUpdate`, `recordedAt` |
| `ignition` | `ignitionStatus`, `acc`, `accStatus` |

### Timestamp formats accepted

- ISO 8601 — `2026-11-12T09:30:00+05:30` (preferred, because the timezone is explicit)
- `DD-MM-YYYY HH:mm:ss` — `12-11-2026 09:30:00` (read as IST)
- Unix epoch seconds (`1762922400`) or milliseconds (`1762922400000`)

### One reading

```json
{
  "vehicleNumber": "GJ18BV6551",
  "latitude": 16.2041,
  "longitude": 77.3556,
  "speed": 54.2,
  "address": "NH-150A near Yeramaras, Raichur, Karnataka",
  "timestamp": "2026-11-12T09:30:00+05:30"
}
```

### A batch (preferred when they buffer)

A bare array works:

```json
[
  { "vehicleNumber": "GJ18BV6551", "latitude": 16.2041, "longitude": 77.3556, "speed": 54.2, "address": "NH-150A, Raichur", "timestamp": "2026-11-12T09:30:00+05:30" },
  { "vehicleNumber": "KA36B1234",  "latitude": 16.1890, "longitude": 77.3401, "speed": 0,    "address": "RVP Industries, Raichur", "timestamp": "2026-11-12T09:30:00+05:30" }
]
```

So does a wrapper object under any of `data`, `records`, `positions`, `items`, `result`, `results`, `payload`:

```json
{ "data": [ { "vehicle_no": "GJ18BV6551", "lat": "16.2041", "long": "77.3556", "speed": "54.2", "address": "NH-150A, Raichur" } ] }
```

Maximum **500 readings per call** (`413` above that). Split a larger buffer across calls.

---

## 4. Responses

**`200 OK`** — accepted. Nothing needs to be retried.

```json
{ "received": 2, "accepted": 2, "stored": 2, "duplicates": 0, "rejected": [] }
```

`accepted` counts readings that parsed; `stored` counts rows actually written; `duplicates` are readings we already had (see idempotency below). A `rejected` entry names the index and the reason, e.g. `{ "index": 3, "reason": "no GPS fix (0,0)" }` — those four were dropped on purpose and re-sending them will not help.

| Code | Meaning | Should they retry? |
|---|---|---|
| `200` | Stored (fully or partly) | No |
| `400` | Body had no readings, or **every** reading was unusable — the `rejected` list says why | No, fix the payload |
| `401` | Token missing or wrong | No, contact us |
| `413` | More than 500 readings in one call | Yes, in smaller batches |
| `429` | More than 60 calls in a minute | Yes, after a short back-off |
| `503` | Our endpoint is not configured / server waking | Yes |

### Retries are safe

A reading is identified by (provider, vehicle, device timestamp). Re-sending a batch after a timeout stores nothing twice — the duplicates just come back in the `duplicates` count. So they can retry freely on any network error.

### Rate limit

60 calls per minute. A push every 30 seconds for each of 20 lorries is 40/minute, so batching 2–3 lorries per call leaves plenty of headroom. Push interval is their choice — anything from 30 seconds to 10 minutes suits us.

### Readings we drop on purpose

- `latitude`/`longitude` missing or not a number
- coordinates outside ±90 / ±180
- exactly `0,0` — every tracker reports this when it has no satellite fix, and it would put the lorry in the Atlantic
- a device clock more than an hour in the future (we stamp arrival time instead of dropping it)

---

## 5. Test call

```bash
curl -i -X POST https://rvp-server.onrender.com/api/webhooks/gps \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <token>" \
  -d '{"vehicleNumber":"GJ18BV6551","latitude":16.2041,"longitude":77.3556,"speed":54.2,"address":"NH-150A, Raichur","timestamp":"2026-11-12T09:30:00+05:30"}'
```

Expect `200` and `{"received":1,"accepted":1,"stored":1,...}`. Sending the identical call again should return `"stored":0,"duplicates":1` — that is the idempotency working, not a failure.

**Vehicles to start with:** we do not maintain a whitelist. Any plate they push is stored. Positions become visible against a consignment once that plate matches a dispatch in the ERP, so the only thing that matters is that the plate they send is the real plate.

---

## 6. Our side (not for Locanix)

### What exists now

| Piece | File |
|---|---|
| `VehiclePing` model | [schema.prisma](server/prisma/schema.prisma) — unique on `(provider, vehicleNumber, recordedAt)`, which is what makes retries idempotent |
| Ingest + parser + reads | [gps.controller.ts](server/src/controllers/gps.controller.ts) |
| Public push routes | [routes/index.ts](server/src/routes/index.ts) — mounted ahead of `requireAuth`, with `webhookLimiter` |
| Authenticated read routes | [gps.routes.ts](server/src/routes/gps.routes.ts) |
| Permission rule | [routePermissions.ts](server/src/lib/routePermissions.ts) — `GET /gps/*` needs `sale.view` |
| Tests | [gpsIngest.test.ts](server/tests/gpsIngest.test.ts) — 29 cases: the alias/format shapes above, plus the endpoint's auth, batching, dedupe and failure codes |
| Archive class | [registry.ts](server/src/archive/registry.ts) — `EXCLUDED`: telemetry, not the books, and thousands of rows per lorry-trip |

Reads for our own screens:

- `GET /api/gps/vehicles` — latest reading per vehicle. `?active=true` narrows it to lorries on a dispatch still in `DISPATCHED` status, which is what the dispatch board wants.
- `GET /api/gps/vehicles/:vehicleNumber` — `{ latest, trail }`, with `from` / `to` / `limit` (default 200, max 1000).

The browser reads these, never Locanix. The push token stays server-side.

### Two steps before it is live

1. `GPS_PUSH_TOKEN` on the Render service — 32+ random characters. **Until it is set the endpoint returns `503` and stores nothing**, which is deliberate: an unset token must not mean "accept anything" on an endpoint that writes to the database from the open internet.
2. `npx prisma db push` from `server/` to create the `VehiclePing` table. (Standing rule for this project: `db push`, never `migrate dev` — `server/.env` points straight at Supabase.)

### Left to build

- **The map panel.** A "Track" button on the Sale Dispatch row: last position, speed, minutes since the last ping, distance remaining, ETA. Leaflet + OpenStreetMap tiles keeps it free.
- **Plate matching.** `normaliseVehicleNumber` strips separators and upper-cases both sides, so `KA 36 B 1234` typed at dispatch matches `ka36b1234` pushed by the device. A plate that is genuinely mistyped still will not match — worth surfacing "pings for a plate no dispatch claims" somewhere, as that is the signal.
- **Retention.** One lorry pushing every 30 seconds for a 2-day run is ~5,800 rows. Twenty lorries a month is ~120k rows/month, which Postgres does not notice, but there is no pruning job yet — add one that thins pings older than ~90 days down to one per 15 minutes.
- **Alerts, once data is flowing.** WhatsApp the buyer when the lorry is within 50 km; flag a lorry stationary more than 4 hours; auto-stamp the actual delivery time on a destination geofence. This is where the value is — halting disputes and "where is my truck" calls both stop.

### Still true from the pull-API note

This is a **per-vendor** integration. A lorry whose owner uses a different GPS vendor pushes nothing here, so the FASTag/toll-read option in that note remains the fallback for spot-hired lorries. The `provider` column and the alias-tolerant parser mean a second vendor is a URL and a token, not a code change.
