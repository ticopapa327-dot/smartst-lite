# SmartST Native Worker

This is the first Rust Native Worker skeleton for SmartST Lite.

## Current Scope

- JSON Lines control plane over stdin/stdout.
- Commands: `listDevices`, `probeVideoCapabilities`, `captureVideoSample`, `start`, `stop`, `status`, `shutdown`.
- `listDevices` uses Windows native enumeration when available:
  - Video: Media Foundation device source enumeration.
  - Audio capture: WASAPI/Core Audio endpoint enumeration.
- Mock fallback is still available when native enumeration fails.
- Channel start/stop state is still mock-native only.
- `captureVideoSample` verifies a single Media Foundation sample read only.
- No continuous frame pipeline, WASAPI stream capture, LiveKit native publishing, or real recording yet.

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

## Probe Video Capabilities

```powershell
npm run media-worker:native:video-probe
```

Environment overrides:

```powershell
$env:SMARTST_NATIVE_VIDEO_INDEX="0"
$env:SMARTST_NATIVE_VIDEO_MEDIA_TYPE_INDEX="0"
$env:SMARTST_NATIVE_VIDEO_MAX_TYPES="128"
$env:SMARTST_NATIVE_VIDEO_MAX_ATTEMPTS="60"
npm run media-worker:native:video-probe
```

## Smoke Test

```powershell
npm run media-worker:native:smoke
```

## Boundary

The protocol shape mirrors `media-worker-poc/worker.mjs`, but this process is intended to become the production worker. High-volume media frames must stay in native pipelines; JSON Lines is only the control and status channel.

`listDevices` still reports device capabilities as `capabilitiesStatus=not-enumerated`. Run `probeVideoCapabilities` or `media-worker:native:video-probe` for Media Foundation media types.

`captureVideoSample` proves the source reader can return one native sample. It does not decode, preview, publish, encode, or record that sample.
