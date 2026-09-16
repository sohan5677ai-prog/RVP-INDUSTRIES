# Kata Cabin: one-time setup

The permanent cabin screen is `https://rvpindustries.co.in/kata-cabin`. It contains only the weighbridge console—no ERP navigation and no staff login page.

## 1. Create the operator account

In **Users**, create a normal `USER` account with username `kata-cabin` (or choose another username and use the same value for `KATA_CABIN_USERNAME`). Name it after the operator or `Kata Cabin`. This name is recorded on each ticket.

## 2. Configure the cloud server

On the deployed API, set the camera relay key (minimum 24 characters). The
browser activation key is derived securely from the existing `JWT_SECRET`; a
separate `KATA_CABIN_ACCESS_KEY` remains an optional override:

```text
KATA_CABIN_USERNAME=kata-cabin
KATA_CABIN_ACCESS_KEY=<optional unique random override>
CCTV_BRIDGE_KEY=<a different unique random secret>
```

Do not put either secret in the website source, an RTSP URL, or a chat message.

## 3. Configure the cabin PC bridge

Set the following Windows environment variables for the account that starts `scripts/start-cctv-bridge.vbs`, then restart the bridge:

```text
CLOUD_API_URL=https://rvp-server.onrender.com/api
CCTV_BRIDGE_KEY=<exactly the same CCTV_BRIDGE_KEY as the cloud server>
CCTV_CLOUD_FRAME_INTERVAL_MS=1000
```

The bridge is outbound-only: it reads RTSP on the cabin LAN and posts a signed JPEG frame to the ERP cloud every second. No camera port forwarding, public IP, or public RTSP link is required.

## 4. Activate the kiosk browser once

On the physical cabin PC only, open:

```text
https://rvpindustries.co.in/kata-cabin?activate=<KATA_CABIN_ACCESS_KEY>
```

The page immediately removes the secret from the address bar and stores the installation credential locally in that browser. Thereafter, opening `/kata-cabin` goes straight to the Kata screen without a login. Do not open that activation link on an untrusted machine. If the cabin PC is replaced, clear its site data and activate the replacement once.

## Remote camera checks

1. Start the bridge on the cabin PC and ensure both cameras are visible locally.
2. From a mobile network, open the normal ERP Weighbridge screen and confirm each view switches to `CLOUD`.
3. If unavailable, read the bridge window/log. It now prints a concise `Cloud relay Cam …` message no more than once per 30 seconds, rather than silently flooding parallel uploads.

The camera IPs (`192.168.1.x`) are intentionally local-only. Remote visibility works through the signed outbound relay, so it continues to work from another town as long as the cabin PC, cameras, and internet are online.
