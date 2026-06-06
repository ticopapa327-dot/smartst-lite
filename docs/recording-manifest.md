# 视捷UST Recording Manifest v0.1

`RecordingManifest` is the metadata contract for local surgical recording files.

The current PoC intentionally avoids patient data and writes `patientBinding.status=unbound`.

## Required Fields

- `schemaVersion`: currently `ust.recording-manifest.v0.1`.
- `recordingId`: locally unique recording identifier.
- `createdAt` and `updatedAt`: ISO timestamps.
- `patientBinding`: HIS binding state; no real patient data in PoC.
- `source`: capture source and probe API.
- `channels`: per-channel recording state and file metadata.
- `storage`: local storage path and export/FTP status.
- `aiProcessing`: reserved post-processing interface.
- `events`: append-only lifecycle and error events.

## Channel Status

- `completed`: file exists and checksum was calculated.
- `failed`: recording was attempted but file validation failed.
- `skipped`: recording was not attempted, usually because no device was available.

## Current Boundary

The AD-09 PoC may write a short DirectShow/ffmpeg validation file, but the final production recorder still requires Native Media Worker integration, patient-safe retention policy, audit logging, and failure recovery testing.
