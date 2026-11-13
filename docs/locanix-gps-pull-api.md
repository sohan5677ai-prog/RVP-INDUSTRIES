# Locanix GPS — the pull integration (what is actually built)

**Status:** built, and verified against the live feed on 13 Nov 2026. The poller stores positions; the Vehicle Tracking page reads them.

This supersedes the technical half of both [locanix-gps-api-request.md](locanix-gps-api-request.md) (what we asked for) and [locanix-gps-push-api.md](locanix-gps-push-api.md) (the webhook we built when they offered to push). The provider ended up shipping a **pull** API, so we poll them. The push webhook stays mounted and tested — a second vendor is then a token, not a deployment.

---

## 1. Their API, as it actually behaves

Suresh Suryawanshi sent one line: the endpoint and a key. Everything below is what a live call showed, not what was documented.

```bash
curl -s 'https://compass.apps2.uctechlabs.com/api/standard-api' \
  -H 'X-Api-Key: <key>'
```

| | |
|---|---|
| Method | `GET`, **no parameters** |
| Returns | the last known position of **every vehicle on the account** — 145 on the first pull, site `227` / `SMTC` |
| Rate limit | **one pull per 30 seconds per token**. Past that: HTTP 200 with `{"ok":false,"error":"Rate limited...","retryAfterSeconds":16}` — not a 429, so the status code alone does not tell a refusal from a feed |
| History | **none.** There is no trail endpoint. A trip has a trail only because we poll and store |
| Per-vehicle filter | none |

One vehicle, verbatim:

```json
{
  "vehicle": "GJ18-BV-6551", "speed": 52, "odometer": 1672916.01,
  "status": "Moving", "latitude": 17.089472, "longitude": 79.26758,
  "heading": 111, "id": 8268, "ignition": "On",
  "timestamp": "2026-11-13T20:15:31.000+05:30",
  "timestampUTC": "2026-11-13T14:45:31.000Z"
}
```

### Things to know before trusting a number

- **`odometer` units are not consistent.** The envelope says km, but values on one feed run from 3,890 to 75,433,852 — some devices clearly report metres. It is stored and displayed as a raw reading and is **never** used to compute a distance. Trip distance is summed along the trail instead.
- **Most of the feed is stale.** On the first pull, 93 of 145 were `Offline` and 21 had not reported in over a week. A device's `timestamp` is the only honest measure of freshness.
- **Two rows came in at exactly `0,0`** — no satellite fix. They are dropped on ingest; `0,0` is in the Gulf of Guinea.
- **Plates are hyphenated** (`GJ18-BV-6551`). We key on the separator-stripped form, so a plate typed `GJ18BV6551` at dispatch matches.

---

## 2. Our side

| Piece | File |
|---|---|
| Pull client, thinning, rate-limit stand-down | [locanix.service.ts](../server/src/services/locanix.service.ts) |
| The poll loop | [gpsPollJob.ts](../server/src/jobs/gpsPollJob.ts) |
| Parser, board and detail reads | [gps.controller.ts](../server/src/controllers/gps.controller.ts) |
| Destinations and distance maths | [gpsPlaces.ts](../server/src/lib/gpsPlaces.ts) |
| Routes | [gps.routes.ts](../server/src/routes/gps.routes.ts) |
| The page | [VehicleTracking.tsx](../client/src/pages/Reports/VehicleTracking.tsx), [VehicleMap.tsx](../client/src/components/VehicleMap.tsx) |
| Tests | [gpsLocanixFeed.test.ts](../server/tests/gpsLocanixFeed.test.ts), [gpsIngest.test.ts](../server/tests/gpsIngest.test.ts) |

### Configuration

```
LOCANIX_BASE_URL="https://compass.apps2.uctechlabs.com/api/standard-api"
LOCANIX_API_KEY="…"
LOCANIX_POLL_SECONDS="60"      # clamped to a 35s floor
LOCANIX_POLL_ENABLED="false"   # optional: hold the poller off, keep the key
```

Without `LOCANIX_API_KEY` the poller never starts and the page says so plainly, rather than showing an empty board that looks like a parked fleet.

### How much we store

One call returns 145 vehicles, of which a handful are ours. Storing every vehicle at full resolution would be roughly 200,000 rows a day for lorries we have no consignment on, so:

- **A plate on one of our dispatches** (DISPATCHED, dispatched within 14 days) — every new fix is kept.
- **Every other vehicle** — a fix is kept only when it carries news: 5 minutes since the last stored one, 200 m of movement, or a change of state.

Idempotency is unchanged from the push design: `(provider, vehicleNumber, recordedAt)` is unique and inserts skip duplicates, so a replayed poll stores nothing twice.

### Endpoints

| Route | What |
|---|---|
| `GET /api/gps/fleet` | the board: latest position per vehicle, joined to its dispatch, with state, distance and ETA already computed. `?scope=dispatch` narrows to our consignments |
| `GET /api/gps/vehicles/:plate/detail` | one lorry: trail, distance covered, driving vs standing time, every halt over 20 minutes |
| `GET /api/gps/status` | integration health — last poll, rows stored, whether a key is even set |
| `POST /api/gps/poll` | pull now (the page's refresh button) |
| `GET/POST /api/webhooks/gps` | the push path, for a provider that prefers to push |

All reads need `sale.view`. The browser never calls Locanix, so the key stays server-side.

---

## 3. The honest state of it, 13 Nov 2026

The integration works. What it cannot yet show is a consequence of whose lorries these are:

- The feed is **Shree Madhupuri's Gujarat fleet** — 125 of 145 plates are `GJ18`.
- Every one of RVP's 13 open dispatches is on a **TN or AP** plate. **Right now the overlap is zero**, so the board shows 13 lorries as "never reported".
- `GJ18BV6551`, the vehicle in the original request mail, **is** tracked and reporting every ~30 seconds.

So the page is ready before the data is. Two things make it pay:

1. **Get the lorries we actually use onto a tracked device** — either this vendor for the regular transporters, or a second provider pushed to `/api/webhooks/gps`. The `provider` column and the alias-tolerant parser mean a second vendor is configuration, not code.
2. **Fill in `destination` on sale orders.** None of the 13 open dispatches has one, and without it there is no ETA and no "km to go" — only a position.

### The factory point

`FACTORY` in [gpsPlaces.ts](../server/src/lib/gpsPlaces.ts) is **13.3658707, 78.5882473** — the mill on New Bypass Road, Kummaranatham Village, Punganur, Chittoor, matching the address on `CompanyProfile` (GSTIN state code 37, Andhra Pradesh).

It was first written as Raichur, Karnataka, on a wrong assumption carried over from an earlier draft of the request mail. That put the origin of every distance about 500 km from the real gate, and nothing on screen contradicted it. A test now pins the coordinates so the same slip cannot be made twice.

Still open with Suresh: whether a history endpoint exists, whether more vehicles can be added to this key, what the odometer units are per device, and the commercials and validity of the token.

### Worth building next, once positions are flowing

- WhatsApp the buyer when the lorry is within 50 km, and auto-stamp the delivery time on a destination geofence.
- Flag a lorry stationary over 4 hours.
- A pruning job: one lorry pushing every 30 seconds for two days is ~5,800 rows. Postgres will not notice, but nothing thins old pings yet.
