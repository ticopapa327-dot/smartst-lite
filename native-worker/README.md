# SmartST Native Worker

This is the first Rust Native Worker skeleton for SmartST Lite.

## Current Scope

- JSON Lines control plane over stdin/stdout.
- Commands: `listDevices`, `probeVideoCapabilities`, `captureVideoSample`, `measureVideoFrames`, `probeAudioFormat`, `captureAudioBuffer`, `start`, `stop`, `status`, `shutdown`.
- `listDevices` uses Windows native enumeration when available:
  - Video: Media Foundation device source enumeration.
  - Audio capture: WASAPI/Core Audio endpoint enumeration.
- Mock fallback is still available when native enumeration fails.
- Channel `start`/`stop`/`status` now exposes a native capture session skeleton with device binding metadata plus stoppable Media Foundation video and WASAPI audio statistics threads.
- `captureVideoSample` verifies a single Media Foundation sample read only.
- `measureVideoFrames` runs a short Media Foundation SourceReader loop and returns frame-rate statistics only.
- `probeAudioFormat` reads WASAPI mix format for capture endpoints.
- `captureAudioBuffer` verifies short WASAPI capture buffer access and returns packet/frame statistics only.
- No frame queue, preview renderer, AEC processing, LiveKit native publishing, or real recording yet.

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

## Measure Video Frame Loop

```powershell
npm run media-worker:native:video-loop
```

Environment overrides:

```powershell
$env:SMARTST_NATIVE_VIDEO_INDEX="0"
$env:SMARTST_NATIVE_VIDEO_MEDIA_TYPE_INDEX="0"
$env:SMARTST_NATIVE_VIDEO_DURATION_MS="2000"
$env:SMARTST_NATIVE_VIDEO_MAX_READS="10000"
npm run media-worker:native:video-loop
```

## Probe Audio Format And Buffer

```powershell
npm run media-worker:native:audio-probe
```

Environment overrides:

```powershell
$env:SMARTST_NATIVE_AUDIO_INDEX="0"
$env:SMARTST_NATIVE_AUDIO_DURATION_MS="500"
$env:SMARTST_NATIVE_AUDIO_POLL_INTERVAL_MS="10"
npm run media-worker:native:audio-probe
```

## Probe Native Capture Session

```powershell
npm run media-worker:native:session
```

Environment overrides:

```powershell
$env:SMARTST_NATIVE_SESSION_CHANNELS="field-camera,endoscope"
$env:SMARTST_NATIVE_VIDEO_MEDIA_TYPE_INDEX="0"
$env:SMARTST_NATIVE_AUDIO_INDEX="0"
$env:SMARTST_NATIVE_SESSION_HOLD_MS="500"
npm run media-worker:native:session
```

## Smoke Test

```powershell
npm run media-worker:native:smoke
```

## Boundary

The protocol shape mirrors `media-worker-poc/worker.mjs`, but this process is intended to become the production worker. High-volume media frames must stay in native pipelines; JSON Lines is only the control and status channel.

`listDevices` still reports device capabilities as `capabilitiesStatus=not-enumerated`. Run `probeVideoCapabilities` or `media-worker:native:video-probe` for Media Foundation media types, and run `probeAudioFormat` or `media-worker:native:audio-probe` for WASAPI mix format.

`captureVideoSample` proves the source reader can return one native sample. It does not decode, preview, publish, encode, or record that sample.

`measureVideoFrames` proves the source reader can keep returning native samples for a short interval. It returns statistics only; it still does not move frame payloads through JSON Lines, render preview, publish, encode, or record.

`captureAudioBuffer` proves the WASAPI capture client can return short native buffers. It does not decode, resample, echo-cancel, publish, encode, or record PCM data.

`start` now binds requested channels to currently available Media Foundation devices by index and binds one WASAPI capture endpoint for session metadata. Missing video devices are reported as `waiting-for-device`; they do not block the worker from starting. `start` starts one Media Foundation video statistics thread and one WASAPI audio statistics thread by default when matching devices are bound; pass `startVideoThread=false` or `startAudioThread=false` to keep either disabled.
