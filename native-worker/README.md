# SmartST Native Worker

This is the first Rust Native Worker skeleton for SmartST Lite.

## Current Scope

- JSON Lines control plane over stdin/stdout.
- Commands: `listDevices`, `start`, `stop`, `status`, `shutdown`.
- `listDevices` uses Windows native enumeration when available:
  - Video: Media Foundation device source enumeration.
  - Audio capture: WASAPI/Core Audio endpoint enumeration.
- Mock fallback is still available when native enumeration fails.
- Channel start/stop state is still mock-native only.
- No real frame capture, WASAPI stream capture, LiveKit native publishing, or real recording yet.

## Run

```powershell
npm run media-worker:native
```

## Build

```powershell
npm run media-worker:native:build
```

## List Native Devices

```powershell
npm run media-worker:native:list-devices
```

## Smoke Test

```powershell
npm run media-worker:native:smoke
```

## Boundary

The protocol shape mirrors `media-worker-poc/worker.mjs`, but this process is intended to become the production worker. High-volume media frames must stay in native pipelines; JSON Lines is only the control and status channel.

Current device capabilities are intentionally reported as `capabilitiesStatus=not-enumerated`. Capability probing and actual sample capture are separate next steps.
