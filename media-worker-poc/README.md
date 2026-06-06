# 视捷UST Media Worker PoC

This proof-of-concept validates the control-plane boundary for a future native media worker.

## Scope

- Worker process lifecycle over JSON Lines stdin/stdout.
- Mock `listDevices`, `start`, `stop`, and `status` commands.
- Mock `startSyntheticPublisher` and `stopSyntheticPublisher` commands.
- Device, channel, recording, LiveKit, stats, and error event categories.
- Repeatable start/stop behavior.

## Out of Scope

- Real USB capture.
- Real Media Foundation or WASAPI access.
- Real LiveKit publishing.
- Real recording files.

## Run

```powershell
npm run media-worker:poc
```

Smoke test:

```powershell
npm run media-worker:poc:smoke
```

Device probe preflight:

```powershell
npm run media-worker:device-probe
npm run media-worker:device-probe:smoke
```

The device probe uses ffmpeg DirectShow as a Windows preflight. It is useful for checking whether cameras and microphones are visible and can be opened, but it is not the final Media Foundation/WASAPI implementation.

Recording manifest PoC:

```powershell
npm run recording:poc
npm run recording:poc:smoke
```

Recording PoC outputs go to `runtime/recordings-poc/`, which is ignored by git. The manifest is the important contract; generated video files are local validation artifacts only.

## Message Format

Send one JSON object per line:

```json
{"id":"1","method":"listDevices"}
{"id":"2","method":"start","params":{"channels":["field-camera"]}}
{"id":"3","method":"status"}
{"id":"4","method":"startSyntheticPublisher","params":{"roomName":"lk-room-poc","trackNames":["video:synthetic-field","audio:synthetic-room"]}}
{"id":"5","method":"stopSyntheticPublisher"}
{"id":"6","method":"stop"}
```

Responses:

```json
{"type":"response","id":"1","ok":true,"result":{}}
```

Events:

```json
{"type":"event","event":{"category":"channel","name":"started","payload":{}}}
```

All media data remains out of this IPC in the PoC. The future native worker should use this control model while keeping high-volume media on native pipelines.

The synthetic publisher commands are intentionally mock-only. They define the control contract for a future native LiveKit publisher but do not open a LiveKit connection or claim media has been published.
