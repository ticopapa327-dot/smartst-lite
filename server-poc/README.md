# 视捷UST Business Service PoC

This is a no-dependency Node.js proof-of-concept service for 视捷UST call signaling and token policy validation.

It is not a production service.

## Scope

- Endpoint registration and heartbeat.
- Call create, accept, reject, hangup.
- Room policy creation.
- Mock token issuance.
- Real LiveKit JWT signing when explicitly configured.
- Phone observer token lookup by room code.
- Accepted-call default video policy with an auditable selection reason.
- Separate participant limits for interactive clients, Android tablet clients, and phone H5 observers.

## Start

```powershell
npm run server:poc
```

Default URL:

```text
http://127.0.0.1:4780
```

LAN test mode for a surgical-room all-in-one machine:

```powershell
$env:UST_POC_HOST="0.0.0.0"
$env:UST_POC_PORT="4780"
$env:LIVEKIT_TOKEN_MODE="real"
$env:LIVEKIT_URL="ws://<OR-PC-LAN-IP>:7880"
$env:LIVEKIT_API_KEY="<server-side-key>"
$env:LIVEKIT_API_SECRET="<server-side-secret>"
npm run server:poc
```

Use `npm run connectivity:or-lab:start` for the full local LiveKit + business service + H5 observer lab startup.

## Smoke Test

```powershell
npm run server:poc:smoke
npm run server:poc:real-token-smoke
npm run server:poc:livekit-preflight:smoke
```

`server:poc:real-token-smoke` signs JWTs with local test credentials and validates the token payload. It does not connect to a LiveKit server.

`server:poc:livekit-preflight:smoke` verifies that the real LiveKit preflight fails safely when `LIVEKIT_URL`, `LIVEKIT_API_KEY`, or `LIVEKIT_API_SECRET` are missing. It does not require a LiveKit server.

## Real LiveKit Token Mode

Default mode is mock. Enable real JWT signing only on the server side:

```powershell
$env:LIVEKIT_TOKEN_MODE="real"
$env:LIVEKIT_URL="ws://127.0.0.1:7880"
$env:LIVEKIT_API_KEY="..."
$env:LIVEKIT_API_SECRET="..."
npm run server:poc
```

Before manual desktop testing, run the real LiveKit preflight:

```powershell
$env:LIVEKIT_URL="ws://127.0.0.1:7880"
$env:LIVEKIT_API_KEY="..."
$env:LIVEKIT_API_SECRET="..."
npm run server:poc:livekit-preflight
```

The preflight uses the server SDK RoomService API to create and list a unique test room, then asks the business service to issue real OR host and phone observer JWTs for that room. By default it deletes the test room before exiting. Set `UST_LIVEKIT_PREFLIGHT_KEEP_ROOM=1` only when you intentionally want to keep the room for manual debugging.

The API secret must never be used in the desktop client, phone H5, Android tablet client, logs, or exported config.

## Phone Observer Token

Phone H5 clients must request tokens by room code:

```http
POST /api/observer/token
```

Payload:

```json
{
  "roomCode": "ST-20260605-001",
  "identity": "phone-observer-001"
}
```

The service always issues this path as `clientType=web-observer`, `mode=watch`, and subscribe-only grants.

## Default Video Contract

`POST /api/calls/{callId}/accept` and `POST /api/rooms` build `room.mediaPolicy` before any token is issued. The policy is the authority for the startup layout; clients must not infer the default video from USB device order or LiveKit track order.

Selection order:

1. `defaultChannelId` explicitly supplied by the OR accept action.
2. Selectable channel marked `localPrimary=true`.
3. Selectable channel marked `remoteDefault=true`.
4. Selectable enabled channel with the lowest `priority`.
5. If no selectable video exists, use `startupVideoMode=audio-only`.

Policy fields:

```json
{
  "defaultChannelId": "field-camera",
  "defaultTrackName": "video:field-camera",
  "defaultSelectionReason": "manual-accept",
  "startupVideoMode": "default-video",
  "allowedChannelIds": ["field-camera", "panorama", "endoscope", "aux-device"],
  "publishOtherChannelsOnDemand": true
}
```

The same default fields are copied into token response `metadata` and real LiveKit JWT metadata. Phone H5 observers receive these fields but still get subscribe-only grants.

## Important Boundaries

- The mock token is not a LiveKit JWT.
- The service does not contain a hardcoded LiveKit API secret.
- Phone H5 clients must use `clientType=web-observer`.
- `web-observer` tokens are subscribe-only and cannot publish audio, video, or data.
