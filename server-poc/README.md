# SmartST Lite Business Service PoC

This is a no-dependency Node.js proof-of-concept service for SmartST Lite call signaling and token policy validation.

It is not a production service.

## Scope

- Endpoint registration and heartbeat.
- Call create, accept, reject, hangup.
- Room policy creation.
- Mock token issuance.
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
```

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
- The service does not contain or require a LiveKit API secret.
- Phone H5 clients must use `clientType=web-observer`.
- `web-observer` tokens are subscribe-only and cannot publish audio, video, or data.
