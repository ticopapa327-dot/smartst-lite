# SmartST Native Worker

This is the first Rust Native Worker skeleton for SmartST Lite.

## Current Scope

- JSON Lines control plane over stdin/stdout.
- Commands: `listDevices`, `probeVideoCapabilities`, `captureVideoSample`, `measureVideoFrames`, `probeAudioFormat`, `captureAudioBuffer`, `start`, `stop`, `consumeVideoPayloadQueue`, `exportVideoPayloadQueuePgm`, `exportVideoPayloadQueuePpm`, `consumeAudioPayloadQueue`, `exportAudioPayloadQueueWav`, `status`, `shutdown`.
- `listDevices` uses Windows native enumeration when available:
  - Video: Media Foundation device source enumeration.
  - Audio capture: WASAPI/Core Audio capture endpoint enumeration.
  - Audio playback: WASAPI/Core Audio render endpoint enumeration.
- Mock fallback is still available when native enumeration fails.
- Channel `start`/`stop`/`status` now exposes a native capture session skeleton with device binding metadata plus stoppable Media Foundation video and WASAPI audio statistics threads.
- `captureVideoSample` verifies a single Media Foundation sample read only.
- `measureVideoFrames` runs a short Media Foundation SourceReader loop and returns frame-rate statistics only.
- `probeAudioFormat` reads WASAPI mix format for capture endpoints.
- `captureAudioBuffer` verifies short WASAPI capture buffer access and returns packet/frame statistics only.
- Video threads expose a native-only bounded `frameQueue` that copies real Media Foundation sample payloads into native memory while keeping JSON Lines as status-only.
- `start` accepts optional `videoChannelBindings` so a channel can bind by Media Foundation device index, deviceId, nativeId, or display name substring instead of relying only on enumeration order.
- `start` accepts optional `videoFormatPreference` to select the nearest native Media Foundation media type by subtype, resolution, and frame rate before starting capture threads.
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

## Probe Native Video Format Preference

```powershell
npm run media-worker:native:format-preference
```

Environment overrides:

```powershell
$env:SMARTST_NATIVE_VIDEO_INDEX="0"
$env:SMARTST_NATIVE_VIDEO_PREFERRED_SUBTYPE="NV12"
$env:SMARTST_NATIVE_VIDEO_FORMAT_MAX_TYPES="128"
npm run media-worker:native:format-preference
```

## Probe Native Channel Binding

```powershell
npm run media-worker:native:channel-binding
```

Environment overrides:

```powershell
$env:SMARTST_NATIVE_VIDEO_INDEX="0"
npm run media-worker:native:channel-binding
```

## Write Native Session Plan Smoke

```powershell
npm run media-worker:native:session-plan
```

Environment overrides:

```powershell
$env:SMARTST_NATIVE_SESSION_PLAN_PATH="native-worker/.tmp/session-plan-smoke.json"
npm run media-worker:native:session-plan
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

## Simulate Native Video Preview Drain

```powershell
npm run media-worker:native:video-preview-drain
```

Environment overrides:

```powershell
$env:SMARTST_NATIVE_PREVIEW_DRAIN_DURATION_MS="2000"
$env:SMARTST_NATIVE_PREVIEW_DRAIN_INTERVAL_MS="250"
$env:SMARTST_NATIVE_PREVIEW_DRAIN_MAX_FRAMES="1"
npm run media-worker:native:video-preview-drain
```

## Export Native Video Payload Queue To PGM

```powershell
npm run media-worker:native:video-pgm-export
```

Environment overrides:

```powershell
$env:SMARTST_NATIVE_SESSION_HOLD_MS="1000"
$env:SMARTST_NATIVE_VIDEO_PGM_EXPORT_MAX_FRAMES="1"
$env:SMARTST_NATIVE_VIDEO_PGM_EXPORT_PATH="native-worker/.tmp/video-payload-export.pgm"
npm run media-worker:native:video-pgm-export
```

## Export Native Video Payload Queue To PPM

```powershell
npm run media-worker:native:video-ppm-export
```

Environment overrides:

```powershell
$env:SMARTST_NATIVE_SESSION_HOLD_MS="1000"
$env:SMARTST_NATIVE_VIDEO_PPM_EXPORT_MAX_FRAMES="1"
$env:SMARTST_NATIVE_VIDEO_PPM_EXPORT_PATH="native-worker/.tmp/video-payload-export.ppm"
npm run media-worker:native:video-ppm-export
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

## Simulate Native Audio Call Drain

```powershell
npm run media-worker:native:audio-call-drain
```

Environment overrides:

```powershell
$env:SMARTST_NATIVE_AUDIO_CALL_DRAIN_DURATION_MS="2000"
$env:SMARTST_NATIVE_AUDIO_CALL_DRAIN_INTERVAL_MS="250"
$env:SMARTST_NATIVE_AUDIO_CALL_DRAIN_MAX_PACKETS="5"
npm run media-worker:native:audio-call-drain
```

## Simulate Native Interaction Drain

```powershell
npm run media-worker:native:interaction-drain
```

Environment overrides:

```powershell
$env:SMARTST_NATIVE_INTERACTION_DRAIN_DURATION_MS="2000"
$env:SMARTST_NATIVE_INTERACTION_DRAIN_INTERVAL_MS="250"
$env:SMARTST_NATIVE_INTERACTION_DRAIN_MAX_VIDEO_FRAMES="1"
$env:SMARTST_NATIVE_INTERACTION_DRAIN_MAX_AUDIO_PACKETS="5"
npm run media-worker:native:interaction-drain
```

## Run Short Native AV Soak

```powershell
npm run media-worker:native:av-soak
```

Environment overrides:

```powershell
$env:SMARTST_NATIVE_AV_SOAK_DURATION_MS="30000"
$env:SMARTST_NATIVE_AV_SOAK_SAMPLE_INTERVAL_MS="500"
$env:SMARTST_NATIVE_AV_SOAK_DRAIN_INTERVAL_MS="500"
$env:SMARTST_NATIVE_AV_SOAK_OUTPUT="native-worker/.tmp/av-soak-smoke.json"
npm run media-worker:native:av-soak
```

## Export Native Audio Payload Queue To WAV

```powershell
npm run media-worker:native:audio-wav-export
```

Environment overrides:

```powershell
$env:SMARTST_NATIVE_SESSION_HOLD_MS="1000"
$env:SMARTST_NATIVE_AUDIO_WAV_EXPORT_MAX_PACKETS="10"
$env:SMARTST_NATIVE_AUDIO_WAV_EXPORT_PATH="native-worker/.tmp/audio-payload-export.wav"
npm run media-worker:native:audio-wav-export
```

## Write Native Export Artifact Manifest

```powershell
npm run media-worker:native:export-artifact-manifest
```

Environment overrides:

```powershell
$env:SMARTST_NATIVE_EXPORT_MANIFEST_PATH="native-worker/.tmp/export-artifact-manifest.json"
$env:SMARTST_NATIVE_EXPORT_MANIFEST_MAX_AGE_MS="300000"
npm run media-worker:native:export-artifact-manifest
```

## Profile WASAPI Audio Levels

```powershell
npm run media-worker:native:audio-profile
```

Environment overrides:

```powershell
$env:SMARTST_NATIVE_AUDIO_PROFILE_LABEL="quiet-room"
$env:SMARTST_NATIVE_AUDIO_PROFILE_DURATION_MS="10000"
$env:SMARTST_NATIVE_AUDIO_PROFILE_SAMPLE_INTERVAL_MS="500"
$env:SMARTST_NATIVE_AUDIO_PROFILE_OUTPUT="tmp/audio-profile-quiet-room.json"
npm run media-worker:native:audio-profile
```

## Profile Native Queue Backpressure

```powershell
npm run media-worker:native:session-backpressure
```

Environment overrides:

```powershell
$env:SMARTST_NATIVE_BACKPRESSURE_DURATION_MS="10000"
$env:SMARTST_NATIVE_BACKPRESSURE_SAMPLE_INTERVAL_MS="500"
$env:SMARTST_NATIVE_BACKPRESSURE_CONSUME_VIDEO_EVERY_MS="0"
$env:SMARTST_NATIVE_BACKPRESSURE_CONSUME_AUDIO_EVERY_MS="0"
npm run media-worker:native:session-backpressure
```

## Smoke Test

```powershell
npm run media-worker:native:smoke
```

## Boundary

The protocol shape mirrors `media-worker-poc/worker.mjs`, but this process is intended to become the production worker. High-volume media frames must stay in native pipelines; JSON Lines is only the control and status channel.

`listDevices` still reports device capabilities as `capabilitiesStatus=not-enumerated`. Run `probeVideoCapabilities` or `media-worker:native:video-probe` for Media Foundation media types, and run `probeAudioFormat` or `media-worker:native:audio-probe` for WASAPI capture mix format. WASAPI render endpoints are enumerated for routing visibility only; render mix-format probing and playback are not implemented.

`captureVideoSample` proves the source reader can return one native sample. It does not decode, preview, publish, encode, or record that sample.

`measureVideoFrames` proves the source reader can keep returning native samples for a short interval. It returns statistics only; it still does not move frame payloads through JSON Lines, render preview, publish, encode, or record.

`captureAudioBuffer` proves the WASAPI capture client can return short native buffers. It does not decode, resample, echo-cancel, publish, encode, or record PCM data.

`start` now binds requested channels to currently available Media Foundation devices by index and binds one WASAPI capture endpoint for session metadata. Missing video devices are reported as `waiting-for-device`; they do not block the worker from starting. `start` starts one Media Foundation video thread per bound video channel and one WASAPI audio statistics thread by default when matching devices are bound. Pass `startVideoThread=false` or `startAudioThread=false` to keep either disabled, pass `videoThreadLimit` / `SMARTST_NATIVE_VIDEO_THREAD_LIMIT` for staged 1/2/4-channel hardware validation, pass `videoFrameQueueCapacity` / `SMARTST_NATIVE_VIDEO_FRAME_QUEUE_CAPACITY` to size the native-only bounded frame payload queue, or pass `audioPayloadQueueCapacity` / `SMARTST_NATIVE_AUDIO_PAYLOAD_QUEUE_CAPACITY` to size the native-only bounded audio packet payload queue.

When `videoFormatPreference` is present, `start` scans native Media Foundation media types and chooses the nearest match by subtype, width, height, frame rate, and optional minimum constraints. The channel response includes `requestedMediaTypeIndex` and `mediaTypeSelection`; the capture thread uses the selected channel `mediaType.mediaTypeIndex`. Without `videoFormatPreference`, behavior remains index-based and defaults to media type index `0`.

When `videoChannelBindings` is present, `start` can bind a requested channel to a specific Media Foundation video device by `index`, `deviceId`, `nativeId`, or `displayNameContains`. The channel response includes `deviceBinding`. Without `videoChannelBindings`, behavior remains enumeration-order based: requested channel N binds to video device N when available.

`session-plan` is a Node-side smoke that combines explicit channel binding and video format preference, starts a short native session, verifies copied frames, and writes `smartst.native-session-plan.v0.1` JSON to `.tmp`. It is a hardware/session configuration aid only; it is not the formal recording manifest, database schema, or LiveKit room contract.

`video-preview-drain` simulates a future preview or publisher consumer by periodically draining one video frame from the native queue and validating increasing sequence metadata, consumed byte counters, and `exportedOverJson=false`. It still does not render pixels, upload GPU textures, publish LiveKit tracks, encode, or record.

Each video thread reports `frameQueue` statistics with `mode=native-payload-bounded` and `payloadTransport=native-only`. The worker copies each Media Foundation sample into a bounded native memory queue and reports `payloadQueue.copyCount`, `payloadQueue.bytes`, `payloadQueue.droppedBytes`, and `payloadQueue.copyErrorCount`; it still does not export frame payloads through JSON Lines. `consumeVideoPayloadQueue` drains queued native payload frames and returns only metadata and byte counters, so it can validate the future preview/publisher/recorder consumer boundary without returning frame bytes. Until a real consumer is attached, new payload frames overwrite the bounded queue after capacity is reached and increment `dropCount`.

`exportVideoPayloadQueuePgm` drains queued NV12 frames and writes a native-side PGM grayscale image from the Y plane. `exportVideoPayloadQueuePpm` drains queued NV12 frames and writes a native-side PPM RGB image using CPU BT.601-style conversion. Both support only NV12 today and return only file metadata plus pixel statistics. These are frame payload/file-consumer validation paths, not preview rendering, color calibration, LiveKit publishing, encoding, or recording.

`listDevices` returns capture endpoints in `audio` and playback/render endpoints in `audioRender`; render enumeration is for future room playback, echo reference, and AEC routing design only. The worker does not open render clients, play audio, capture loopback, or validate speaker quality yet.

The WASAPI audio statistics thread reports `audioLevel` for float32, PCM16, and PCM32 capture formats. It also copies each WASAPI packet into a bounded native memory queue with `payloadQueue.mode=pcm-packet-bounded`, `payloadQueue.transport=native-only`, and `payloadQueue.exportedOverJson=false`. The worker reports `payloadQueue.copyCount`, `payloadQueue.bytes`, `payloadQueue.droppedBytes`, and `payloadQueue.copyErrorCount`; it still does not export PCM payloads through JSON Lines. `consumeAudioPayloadQueue` drains queued native PCM packets and returns only metadata and byte counters, so it can validate the future resampler/AEC/publisher/recorder consumer boundary without returning PCM bytes. `exportAudioPayloadQueueWav` drains queued PCM packets and writes a native-side WAV file for PCM/IEEE_FLOAT mix formats; the JSON response returns only file metadata and byte counters. The level meter reports RMS/peak only; it does not resample, echo-cancel, denoise, publish, encode, or implement final recording policy. Unsupported capture formats are reported as `audioLevel.status=unsupported-format` instead of returning fabricated levels.

`audio-call-drain` simulates a future audio call or publisher consumer by periodically draining native PCM packet batches and validating increasing sequence metadata, byte counters, `payloadTransport=native-only`, and `exportedOverJson=false`. It still does not perform resampling, AEC, denoising, LiveKit publishing, encoding, recording, or audio quality acceptance.

`interaction-drain` starts video and audio in the same native session and periodically drains both queues. It validates the combined control path expected by an interactive teaching connection, but it still does not render preview textures, publish LiveKit tracks, perform AEC, encode, record, or prove end-to-end media sync.

`av-soak` runs a configurable short continuous audio/video capture profile, samples status, periodically drains native video/audio payload queues, verifies copy counters increase, queue depths remain within configured capacity, payload copy errors stay at 0, and writes `smartst.native-av-soak.v0.1` JSON to `.tmp`. It is a sustained local capture/control smoke, not an endurance test, media quality acceptance, LiveKit publisher, AEC test, recording path, or multi-device certification.

`export-artifact-manifest` is a Node-side verification script that reads the generated PGM, PPM, and WAV files, verifies their headers and dimensions, checks the artifact mtime is fresh by default, computes SHA-256 checksums, and writes `smartst.native-export-artifacts.v0.1` JSON. It is an export smoke artifact manifest only; it is not the formal surgical recording manifest, patient binding contract, playback index, or storage policy.

`audio-profile` samples `status` periodically and summarizes packet growth, RMS/peak, silent packets, discontinuities, timestamp errors, and native PCM queue counters. It is intended for quiet-room / speech / external microphone comparison baselines. It does not export PCM payloads, measure echo cancellation, or prove production audio quality.

`session-backpressure` starts the native video and audio threads, samples status, and verifies native payload queue depths remain bounded by configured capacity while drop counters grow when no consumer drains the queues. Optional periodic drain environment variables can simulate future preview, publisher, or recorder consumers. This is a memory/backpressure baseline only; it does not prove dropped frames or packets are acceptable for production.
