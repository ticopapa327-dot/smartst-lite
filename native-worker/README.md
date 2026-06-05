# SmartST Native Worker

This is the first Rust Native Worker skeleton for SmartST Lite.

## Current Scope

- JSON Lines control plane over stdin/stdout.
- Commands: `listDevices`, `start`, `stop`, `status`, `shutdown`.
- Mock native device/channel state only.
- No Media Foundation, WASAPI, LiveKit native publishing, or real recording yet.

## Run

```powershell
npm run media-worker:native
```

## Build

```powershell
npm run media-worker:native:build
```

## Smoke Test

```powershell
npm run media-worker:native:smoke
```

## Boundary

The protocol shape mirrors `media-worker-poc/worker.mjs`, but this process is intended to become the production worker. High-volume media frames must stay in native pipelines; JSON Lines is only the control and status channel.
