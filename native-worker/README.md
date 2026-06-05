# SmartST Native Worker

This is the first Rust Native Worker skeleton for SmartST Lite.

## Current Scope

- JSON Lines control plane over stdin/stdout.
- Commands: `listDevices`, `probeVideoCapabilities`, `captureVideoSample`, `measureVideoFrames`, `probeAudioFormat`, `captureAudioBuffer`, `start`, `stop`, `consumeVideoPayloadQueue`, `consumeAudioPayloadQueue`, `status`, `shutdown`.
- `listDevices` uses Windows native enumeration when available:
  - Video: Media Foundation device source enumeration.
  - Audio capture: WASAPI/Core Audio endpoint enumeration.
- Mock fallback is still available when native enumeration fails.
- Channel `start`/`stop`/`status` now exposes a native capture session skeleton with device binding metadata plus stoppable Media Foundation video and WASAPI audio statistics threads.
- `captureVideoSample` verifies a single Media Foundation sample read only.
- `measureVideoFrames` runs a short Media Foundation SourceReader loop and returns frame-rate statistics only.
- `probeAudioFormat` reads WASAPI mix format for capture endpoints.
- `captureAudioBuffer` verifies short WASAPI capture buffer access and returns packet/frame statistics only.
- Video threads expose a native-only bounded `frameQueue` that copies real Media Foundation sample payloads into native memory while keeping JSON Lines as status-only.
- The WASAPI audio thread exposes a native-only bounded PCM packet payload queue and status counters. Preview rendering, AEC processing, LiveKit native publishing, audio resampling, and real recording are still not implemented.

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
$env:SMARTST_NATIVE_VIDEO_THREAD_LIMIT="2"
$env:SMARTST_NATIVE_VIDEO_FRAME_QUEUE_CAPACITY="3"
$env:SMARTST_NATIVE_AUDIO_INDEX="0"
$env:SMARTST_NATIVE_AUDIO_PAYLOAD_QUEUE_CAPACITY="50"
$env:SMARTST_NATIVE_SESSION_HOLD_MS="500"
npm run media-worker:native:session
```

## Stress Native Capture Session

```powershell
npm run media-worker:native:session-stress
```

Environment overrides:

```powershell
$env:SMARTST_NATIVE_SESSION_STRESS_ITERATIONS="3"
$env:SMARTST_NATIVE_SESSION_HOLD_MS="1000"
$env:SMARTST_NATIVE_VIDEO_THREAD_LIMIT="2"
$env:SMARTST_NATIVE_VIDEO_FRAME_QUEUE_CAPACITY="3"
$env:SMARTST_NATIVE_AUDIO_PAYLOAD_QUEUE_CAPACITY="50"
npm run media-worker:native:session-stress
```

## Consume Native Video Payload Queue

```powershell
npm run media-worker:native:payload-consume
```

Environment overrides:

```powershell
$env:SMARTST_NATIVE_SESSION_HOLD_MS="1000"
$env:SMARTST_NATIVE_VIDEO_PAYLOAD_CONSUME_MAX_FRAMES="2"
$env:SMARTST_NATIVE_VIDEO_FRAME_QUEUE_CAPACITY="3"
npm run media-worker:native:payload-consume
```

## Consume Native Audio Payload Queue

```powershell
npm run media-worker:native:audio-payload-consume
```

Environment overrides:

```powershell
$env:SMARTST_NATIVE_SESSION_HOLD_MS="1000"
$env:SMARTST_NATIVE_AUDIO_PAYLOAD_CONSUME_MAX_PACKETS="5"
$env:SMARTST_NATIVE_AUDIO_PAYLOAD_QUEUE_CAPACITY="50"
npm run media-worker:native:audio-payload-consume
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

`start` now binds requested channels to currently available Media Foundation devices by index and binds one WASAPI capture endpoint for session metadata. Missing video devices are reported as `waiting-for-device`; they do not block the worker from starting. `start` starts one Media Foundation video thread per bound video channel and one WASAPI audio statistics thread by default when matching devices are bound. Pass `startVideoThread=false` or `startAudioThread=false` to keep either disabled, pass `videoThreadLimit` / `SMARTST_NATIVE_VIDEO_THREAD_LIMIT` for staged 1/2/4-channel hardware validation, pass `videoFrameQueueCapacity` / `SMARTST_NATIVE_VIDEO_FRAME_QUEUE_CAPACITY` to size the native-only bounded frame payload queue, or pass `audioPayloadQueueCapacity` / `SMARTST_NATIVE_AUDIO_PAYLOAD_QUEUE_CAPACITY` to size the native-only bounded audio packet payload queue.

Each video thread reports `frameQueue` statistics with `mode=native-payload-bounded` and `payloadTransport=native-only`. The worker copies each Media Foundation sample into a bounded native memory queue and reports `payloadQueue.copyCount`, `payloadQueue.bytes`, `payloadQueue.droppedBytes`, and `payloadQueue.copyErrorCount`; it still does not export frame payloads through JSON Lines. `consumeVideoPayloadQueue` drains queued native payload frames and returns only metadata and byte counters, so it can validate the future preview/publisher/recorder consumer boundary without returning frame bytes. Until a real consumer is attached, new payload frames overwrite the bounded queue after capacity is reached and increment `dropCount`.

The WASAPI audio statistics thread reports `audioLevel` for float32, PCM16, and PCM32 capture formats. It also copies each WASAPI packet into a bounded native memory queue with `payloadQueue.mode=pcm-packet-bounded`, `payloadQueue.transport=native-only`, and `payloadQueue.exportedOverJson=false`. The worker reports `payloadQueue.copyCount`, `payloadQueue.bytes`, `payloadQueue.droppedBytes`, and `payloadQueue.copyErrorCount`; it still does not export PCM payloads through JSON Lines. `consumeAudioPayloadQueue` drains queued native PCM packets and returns only metadata and byte counters, so it can validate the future resampler/AEC/publisher/recorder consumer boundary without returning PCM bytes. The level meter reports RMS/peak only; it does not resample, echo-cancel, denoise, publish, encode, or record audio. Unsupported capture formats are reported as `audioLevel.status=unsupported-format` instead of returning fabricated levels.
