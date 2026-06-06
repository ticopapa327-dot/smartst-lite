# 视捷UST Web Observer PoC

This is the phone H5 proof-of-concept for one-way surgery teaching observation.

## Scope

- Input business service URL and room code.
- Request a `web-observer` token from `server-poc`.
- Verify the returned grants are subscribe-only.
- Subscribe to LiveKit room media when a real JWT is returned.
- Mount the default remote video and remote audio.

## Hard Boundaries

- No camera publishing.
- No microphone publishing.
- No data publishing.
- No annotation, PTZ, or interactive control.
- No surgical room media forwarding by the OR desktop terminal; concurrency belongs to LiveKit/SFU.

## Run

Start the business service PoC:

```powershell
npm run server:poc
```

Start the phone observer page:

```powershell
npm run web-observer:poc:dev
```

LAN mode for phone testing:

```powershell
npm run web-observer:poc:dev:lan
```

When opened through `http://<OR-PC-LAN-IP>:5175`, the page automatically changes the default business service URL to `http://<OR-PC-LAN-IP>:4780`.

Build and smoke test:

```powershell
npm run web-observer:poc:build
npm run web-observer:poc:smoke
```

`server-poc` only returns mock tokens. The page will validate the watch-only policy but will not connect to a real LiveKit server until the business service is replaced with real JWT signing.
