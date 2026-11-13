# Locanix GPS API — request email + integration notes

> **Superseded for the technical part.** Locanix offered to *push* to us instead of us polling them, and the receiving endpoint is now built — see [locanix-gps-push-api.md](locanix-gps-push-api.md), which is the document to send them. Keep this one for the consent/commercials questions in the email below, which still apply.

Send to: **ops@locanix.com**
CC: the transporter (vehicle owner) — their consent is what unlocks the data.

---

## 1. The email (copy-paste, fill the [ ] bits)

**Subject:** GPS Pull API Integration Request — [GJ18BV6551] — RVP Industries ERP

> Dear Locanix Team,
>
> We are **RVP Industries** (Punganur, Chittoor district, Andhra Pradesh), a de-oiled cake / cotton seed processing unit. We operate an in-house logistics and dispatch management software — **"RVP Industries ERP"** — which we use to plan, dispatch and track every inbound and outbound lorry.
>
> We would like to integrate the GPS of the below vehicle with our RVP Industries ERP platform via a **pull-based API**.
>
> **Vehicle No.:** [GJ18BV6551]
> **Transporter:** [Shree Madhupuri Transport]
> **Device/IMEI (if known):** [____]
> **Consignor:** RVP Industries, Punganur
> **Route:** [Punganur → Surat]
>
> The transporter (vehicle owner) is copied on this mail and consents to the location data of this vehicle being shared with RVP Industries for the duration of our consignments.
>
> Kindly share the following so that we can proceed with the integration:
>
> 1. **API documentation** for the pull/REST API (base URL + endpoints).
> 2. **Credentials** — API key / username-password / OAuth token, and whether a **test (sandbox)** credential is available first.
> 3. **Authentication method** — if you authenticate by **IP whitelisting**, please confirm, and we will share our server's static outbound IP.
> 4. **Endpoints we need:**
>    - *Current location* of a vehicle by vehicle number (last known lat/long).
>    - *Location history / trail* between two timestamps.
>    - *(Optional)* bulk endpoint returning the last position of multiple vehicles in one call.
> 5. **Response format** (JSON preferred) with a sample response, and the meaning of each field.
> 6. **Data fields available** — latitude, longitude, timestamp (with timezone), speed, ignition on/off, odometer, GPS/GPRS status, nearest location/address, battery/power status.
> 7. **Polling frequency and rate limits** — how often we may call the API (we would like **every 5–15 minutes** per active vehicle) and the device's own ping interval.
> 8. **Validity / commercials** — any one-time integration charge, per-vehicle or per-API-call charge, and the validity period of the credentials.
> 9. **Process to add more vehicles later** — we hire multiple lorries; please confirm how additional vehicle numbers can be added to the same API account.
> 10. **Technical support contact** (name, mobile, email) for the integration.
>
> This is for an ongoing dispatch programme, so kindly share the API details at the earliest so that we can proceed with the integration.
>
> Thanks & Regards,
> [Your name]
> [Designation], RVP Industries
> [Mobile] | [email]
> [GSTIN, if you want it on the mail]

---

## 2. What kind of API to ask for (plain English)

A **pull-based REST API over HTTPS returning JSON**. "Pull" means *our* server calls *their* server on a timer — we do not need them to push anything to us, and we do not need to open any port.

Three endpoints cover 100% of what the ERP needs:

| What | Typical shape | Why we need it |
|---|---|---|
| Last known position | `GET /api/vehicle/location?vehicle=KA36XXXX` | live "where is my lorry" on the dispatch page |
| Position history | `GET /api/vehicle/history?vehicle=…&from=…&to=…` | replay the trip, prove transit time, settle detention/halting disputes |
| Bulk last position | `GET /api/vehicles/locations` (all vehicles on the account) | one call refreshes the whole dispatch board — cheapest option |

Minimum fields per reading: `vehicleNumber, latitude, longitude, timestamp, speed, ignition, address/landmark, gpsStatus`.

**Two things to settle up-front, because they bite later:**

1. **Auth style.** Ask for a **token/API-key** rather than IP whitelisting. Our server runs on Render — it does have a static outbound IP, but if we ever move region or add a service the whitelist breaks. If they insist on IP whitelisting, we give them the Render service's static outbound IP(s).
2. **Consent + per-vehicle scope.** Locanix will only release a vehicle's location with the **owner's** consent, and only for vehicles whose device is on their platform. So this works for lorries we use repeatedly. For a one-off spot-hired lorry whose owner uses a different GPS vendor, this API will return nothing.

---

## 3. Where it plugs into the RVP ERP

The hook already exists — `SaleDispatch` carries `vehicleNumber`, `driverName`, `driverPhone`, `dispatchDate` and a `DISPATCHED → DELIVERED` status (`server/prisma/schema.prisma`). A dispatch in `DISPATCHED` state *is* an "active trip".

Proposed build (roughly a day's work once credentials arrive):

1. **`VehicleTracker` / `VehiclePing` model** — one row per polled reading: vehicle no, lat, lng, speed, ignition, address, pingedAt, plus `saleDispatchId` so the trail is tied to the consignment.
2. **`server/src/gps/locanix.service.ts`** — thin client for their API, credentials in `server/.env` (`LOCANIX_BASE_URL`, `LOCANIX_API_KEY`), same pattern as the TaxPro and Fast2SMS services already in the repo.
3. **A node-cron job every 10 minutes** that polls only vehicles attached to a dispatch still in `DISPATCHED` status — so we never burn API calls on idle lorries, and the job costs nothing when nothing is moving.
4. **UI** — a "Track" button / live map panel on the Sale Dispatch row: last ping, speed, how long since the last update, distance remaining, and ETA. A map (Leaflet + OpenStreetMap tiles) keeps it free.
5. **Alerts, once the data is flowing** — WhatsApp the buyer/broker on "vehicle within 50 km", flag a lorry stationary > 4 hours, and auto-stamp the actual delivery time when the lorry reaches the destination geofence. This is where the real money is: halting disputes and "where is my truck" phone calls both disappear.

**Bandwidth/cost note:** polling 10 active lorries every 10 minutes is ~1,440 calls/day — trivial. Keep the frontend reading our own DB, never calling Locanix directly from the browser (that would leak the API key and multiply the call count).

---

## 4. Worth knowing before you commit

- **This is a per-device integration, not fleet-wide tracking.** One mail per GPS vendor per owner. If your lorries come from 10 different transporters with 5 different GPS vendors, you will be chasing 5 integrations.
- **A vendor-neutral alternative exists:** FASTag/toll-read based tracking (via the e-way bill / NETC data that aggregators like Intugine, Fleetx, LocoNav or FreightTiger resell) works on **any** vehicle number with no device and no vendor consent. It is coarser — you get a position only when the lorry crosses a toll plaza, roughly every 50–150 km — but for a Punganur → Surat run that is 6–10 reliable fixes, which is usually enough to answer "where is it and will it reach tomorrow".
- Best setup is both: **Locanix (or whichever vendor) for the regular lorries, FASTag-based for the rest.** Build the ERP side (`VehiclePing` + the map panel) provider-agnostic so a second provider is just another service file.
