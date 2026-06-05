# SmartST Lite Business Service PoC

This is a no-dependency Node.js proof-of-concept service for SmartST Lite call signaling and token policy validation.

It is not a production service.

## Scope

- Endpoint registration and heartbeat.
- Call create, accept, reject, hangup.
- Room policy creation.
- Mock token issuance.
- Real LiveKit JWT signing when explicitly configured.
- Phone observer token lookup by room code.
- Separate participant limits for interactive clients, Android tablet clients, and phone H5 observers.

## Start

```powershell
npm run server:poc
```

Default URL:

```text
http://127.0.0.1:4780
```

## Smoke Test

```powershell
npm run server:poc:smoke
npm run server:poc:real-token-smoke
```

`server:poc:real-token-smoke` signs JWTs with local test credentials and validates the token payload. It does not connect to a LiveKit server.

## Real LiveKit Token Mode

Default mode is mock. Enable real JWT signing only on the server side:

```powershell
$env:LIVEKIT_TOKEN_MODE="real"
$env:LIVEKIT_URL="ws://127.0.0.1:7880"
$env:LIVEKIT_API_KEY="..."
$env:LIVEKIT_API_SECRET="..."
npm run server:poc
```

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

## Important Boundaries

- The mock token is not a LiveKit JWT.
- The service does not contain a hardcoded LiveKit API secret.
- Phone H5 clients must use `clientType=web-observer`.
- `web-observer` tokens are subscribe-only and cannot publish audio, video, or data.
