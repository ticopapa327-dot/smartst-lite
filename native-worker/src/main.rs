use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::ptr;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows::core::{BSTR, GUID, PWSTR};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Media::Audio::{
    eCapture, IAudioCaptureClient, IAudioClient, IMMDevice, IMMDeviceEnumerator,
    MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY, AUDCLNT_BUFFERFLAGS_SILENT,
    AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR, AUDCLNT_SHAREMODE_SHARED, DEVICE_STATE_ACTIVE,
    WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
use windows::Win32::Media::MediaFoundation::{
    IMFActivate, IMFAttributes, IMFMediaSource, IMFMediaType, MFCreateAttributes,
    MFCreateSourceReaderFromMediaSource, MFEnumDeviceSources, MFMediaType_Video, MFShutdown,
    MFStartup, MFVideoFormat_H264, MFVideoFormat_HEVC, MFVideoFormat_I420, MFVideoFormat_MJPG,
    MFVideoFormat_NV12, MFVideoFormat_RGB24, MFVideoFormat_RGB32, MFVideoFormat_UYVY,
    MFVideoFormat_YUY2, MFVideoFormat_YV12, MFSTARTUP_FULL, MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME,
    MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
    MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE,
    MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_SOURCE_READERF_ALLEFFECTSREMOVED,
    MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED, MF_SOURCE_READERF_ENDOFSTREAM,
    MF_SOURCE_READERF_ERROR, MF_SOURCE_READERF_NATIVEMEDIATYPECHANGED, MF_SOURCE_READERF_NEWSTREAM,
    MF_SOURCE_READERF_STREAMTICK, MF_SOURCE_READER_FIRST_VIDEO_STREAM, MF_VERSION,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED, STGM_READ,
};

const DEFAULT_CHANNELS: [&str; 4] = ["panorama", "field-camera", "endoscope", "aux-device"];
const WAVE_FORMAT_PCM_TAG: u16 = 1;
const WAVE_FORMAT_IEEE_FLOAT_TAG: u16 = 3;
const WAVE_FORMAT_EXTENSIBLE_TAG: u16 = 0xfffe;

struct WorkerState {
    process_id: String,
    worker_version: String,
    state: String,
    started_at: Option<String>,
    stopped_at: Option<String>,
    capture_session: Value,
    channels: Vec<Value>,
    recording: Value,
    livekit: Value,
    stats: Value,
    video_runtimes: Vec<VideoCaptureRuntime>,
    audio_runtime: Option<AudioCaptureRuntime>,
    last_error: Option<Value>,
}

struct VideoDeviceActivate {
    index: u32,
    device_id: String,
    display_name: String,
    native_id: String,
    role: &'static str,
    transport: &'static str,
    activate: IMFActivate,
}

struct AudioDeviceRecord {
    index: u32,
    device_id: String,
    display_name: String,
    native_id: String,
    transport: &'static str,
    device: IMMDevice,
}

struct CaptureSessionStart {
    channels: Vec<Value>,
    device_snapshot: Value,
    capture_session: Value,
    stats: Value,
}

struct AudioCaptureRuntime {
    stop: Arc<AtomicBool>,
    stats: Arc<Mutex<AudioCaptureThreadStats>>,
    handle: Option<JoinHandle<()>>,
}

struct VideoCaptureRuntime {
    stop: Arc<AtomicBool>,
    stats: Arc<Mutex<VideoCaptureThreadStats>>,
    handle: Option<JoinHandle<()>>,
}

#[derive(Clone)]
struct AudioCaptureThreadStats {
    state: String,
    started_at: String,
    stopped_at: Option<String>,
    elapsed_ms: u128,
    device_index: u32,
    poll_interval_ms: u32,
    packet_count: u64,
    captured_frames: u64,
    captured_bytes: u64,
    silent_packets: u64,
    discontinuity_packets: u64,
    timestamp_error_packets: u64,
    poll_count: u64,
    last_device_position: Option<u64>,
    last_qpc_position: Option<u64>,
    buffer_frame_capacity: Option<u32>,
    stream_latency_hns: Option<i64>,
    device: Value,
    mix_format: Value,
    last_error: Option<String>,
}

#[derive(Clone)]
struct VideoCaptureThreadStats {
    state: String,
    started_at: String,
    stopped_at: Option<String>,
    elapsed_ms: u128,
    channel_id: String,
    device_index: u32,
    media_type_index: u32,
    frame_queue_capacity: u32,
    frame_queue_depth: u32,
    frame_queue_push_count: u64,
    frame_queue_drop_count: u64,
    frame_queue_latest_sequence: Option<u64>,
    frame_queue_latest_timestamp_hns: Option<i64>,
    frame_queue_latest_sample_time_hns: Option<i64>,
    frame_queue_latest_total_length_bytes: Option<u32>,
    read_count: u64,
    sample_count: u64,
    empty_read_count: u64,
    total_length_bytes: u64,
    total_buffer_count: u64,
    stream_flags_or: u32,
    media_type_changed_count: u64,
    native_media_type_changed_count: u64,
    first_timestamp_hns: Option<i64>,
    last_timestamp_hns: Option<i64>,
    first_sample_time_hns: Option<i64>,
    last_sample_time_hns: Option<i64>,
    sample_duration_sum_hns: i128,
    sample_duration_count: u64,
    device: Value,
    media_type: Value,
    last_error: Option<String>,
}

impl WorkerState {
    fn new() -> Self {
        Self {
            process_id: format!("native-worker-{}", std::process::id()),
            worker_version: "native-poc-0.1".to_string(),
            state: "idle".to_string(),
            started_at: None,
            stopped_at: None,
            capture_session: idle_capture_session(),
            channels: Vec::new(),
            recording: idle_recording(),
            livekit: idle_livekit(),
            stats: idle_stats(),
            video_runtimes: Vec::new(),
            audio_runtime: None,
            last_error: None,
        }
    }

    fn snapshot(&self) -> Value {
        let stats = stats_with_runtimes(
            &self.stats,
            self.audio_runtime.as_ref(),
            &self.video_runtimes,
        );
        json!({
            "processId": self.process_id,
            "workerVersion": self.worker_version,
            "state": self.state,
            "startedAt": self.started_at,
            "stoppedAt": self.stopped_at,
            "captureSession": self.capture_session,
            "channels": self.channels,
            "recording": self.recording,
            "livekit": self.livekit,
            "stats": stats,
            "lastError": self.last_error
        })
    }
}

fn main() {
    let stdin = io::stdin();
    let mut state = WorkerState::new();

    emit_event("worker", "ready", state.snapshot());

    for line in stdin.lock().lines() {
        let Ok(line) = line else {
            emit_event("error", "stdin-read-error", json!({}));
            continue;
        };

        if line.trim().is_empty() {
            continue;
        }

        let message: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => {
                emit_event("error", "invalid-json", json!({ "line": line }));
                continue;
            }
        };

        let id = message.get("id").cloned().unwrap_or(Value::Null);
        match handle_command(&mut state, &message) {
            Ok((result, should_shutdown)) => {
                send_response(id, true, "result", result);
                if should_shutdown {
                    break;
                }
            }
            Err(error) => {
                let payload = json!({
                    "code": error.code,
                    "message": error.message
                });
                state.last_error = Some(payload.clone());
                emit_event("error", error.code, payload.clone());
                send_response(id, false, "error", payload);
            }
        }
    }
}

fn handle_command(state: &mut WorkerState, message: &Value) -> Result<(Value, bool), WorkerError> {
    let method = required_string(message.get("method"), "method")?;
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));

    match method.as_str() {
        "listDevices" => {
            let devices = enumerate_native_devices();
            emit_event("device", "snapshot", devices.clone());
            Ok((devices, false))
        }
        "probeVideoCapabilities" => Ok((
            probe_video_capabilities(&params)
                .map_err(|message| WorkerError::new("native-media-error", message))?,
            false,
        )),
        "captureVideoSample" => Ok((
            capture_video_sample(&params)
                .map_err(|message| WorkerError::new("native-media-error", message))?,
            false,
        )),
        "measureVideoFrames" => Ok((
            measure_video_frames(&params)
                .map_err(|message| WorkerError::new("native-media-error", message))?,
            false,
        )),
        "probeAudioFormat" => Ok((
            probe_audio_format(&params)
                .map_err(|message| WorkerError::new("native-media-error", message))?,
            false,
        )),
        "captureAudioBuffer" => Ok((
            capture_audio_buffer(&params)
                .map_err(|message| WorkerError::new("native-media-error", message))?,
            false,
        )),
        "start" => Ok((start_worker(state, &params), false)),
        "stop" => Ok((stop_worker(state), false)),
        "status" => Ok((state.snapshot(), false)),
        "shutdown" => {
            if state.state != "idle" {
                stop_worker(state);
            }
            Ok((json!({ "shuttingDown": true }), true))
        }
        _ => Err(WorkerError::new(
            "unknown-method",
            format!("Unknown method: {method}"),
        )),
    }
}

fn start_worker(state: &mut WorkerState, params: &Value) -> Value {
    if state.state == "running" {
        emit_event("worker", "already-running", state.snapshot());
        return state.snapshot();
    }

    let requested_channels = params
        .get("channels")
        .and_then(Value::as_array)
        .filter(|channels| !channels.is_empty())
        .map(|channels| {
            channels
                .iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| {
            DEFAULT_CHANNELS
                .iter()
                .map(|channel| channel.to_string())
                .collect()
        });

    let started_at = now_iso_like();
    let session_start = build_capture_session_start(&requested_channels, &params, &started_at);

    state.state = "running".to_string();
    state.started_at = Some(started_at);
    state.stopped_at = None;
    state.channels = session_start.channels;
    state.capture_session = session_start.capture_session;
    state.recording = idle_recording();
    state.livekit = idle_livekit();
    state.stats = session_start.stats;
    let video_frame_queue_capacity = optional_u32(&params, "videoFrameQueueCapacity")
        .ok()
        .flatten()
        .unwrap_or(3)
        .clamp(1, 120);
    for (channel_id, video_index) in video_thread_start_targets(&state.channels, &params) {
        let media_type_index = state.capture_session["videoMediaTypeIndex"]
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .unwrap_or(0);
        state.video_runtimes.push(start_video_capture_runtime(
            channel_id.clone(),
            video_index,
            media_type_index,
            video_frame_queue_capacity,
        ));
        mark_channel_stats_status(&mut state.channels, &channel_id, "running");
    }
    if !state.video_runtimes.is_empty() {
        state.capture_session["continuousVideoThreads"] = json!("running");
        state.capture_session["continuousVideoThreadCount"] = json!(state.video_runtimes.len());
    }
    if should_start_audio_thread(&params, &state.capture_session) {
        let audio_index = state.capture_session["audioIndex"]
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .unwrap_or(0);
        let poll_interval_ms = optional_u32(&params, "audioPollIntervalMs")
            .ok()
            .flatten()
            .unwrap_or(10)
            .clamp(1, 100);
        state.audio_runtime = Some(start_audio_capture_runtime(audio_index, poll_interval_ms));
        state.capture_session["continuousAudioThreads"] = json!("running");
    }

    emit_event("device", "snapshot", session_start.device_snapshot);
    emit_event("capture", "session-started", state.capture_session.clone());
    for video_runtime in &state.video_runtimes {
        emit_event("video", "capture-thread-started", video_runtime.snapshot());
    }
    if let Some(audio_runtime) = state.audio_runtime.as_ref() {
        emit_event("audio", "capture-thread-started", audio_runtime.snapshot());
    }
    for channel in &state.channels {
        emit_event("channel", "started", channel.clone());
    }
    emit_event("recording", "state", state.recording.clone());
    emit_event("livekit", "state", state.livekit.clone());
    state.snapshot()
}

fn stop_worker(state: &mut WorkerState) -> Value {
    if state.state == "idle" {
        emit_event("worker", "already-idle", state.snapshot());
        return state.snapshot();
    }

    for channel in &state.channels {
        emit_event(
            "channel",
            "stopped",
            json!({
                "channelId": channel.get("channelId").cloned().unwrap_or(Value::Null),
                "state": "stopped"
            }),
        );
    }

    let video_threads_stopped = stop_video_capture_runtimes(state);
    let audio_thread_stopped = stop_audio_capture_runtime(state);
    let previous_session = state.capture_session.clone();
    state.state = "idle".to_string();
    state.stopped_at = Some(now_iso_like());
    state.channels.clear();
    state.capture_session = idle_capture_session();
    state.recording = idle_recording();
    state.livekit = idle_livekit();
    state.stats = idle_stats();
    for video_stats in video_threads_stopped {
        emit_event("video", "capture-thread-stopped", video_stats);
    }
    if let Some(audio_stats) = audio_thread_stopped {
        emit_event("audio", "capture-thread-stopped", audio_stats);
    }
    emit_event("capture", "session-stopped", previous_session);
    emit_event("worker", "stopped", state.snapshot());
    state.snapshot()
}

fn build_capture_session_start(
    requested_channels: &[String],
    params: &Value,
    started_at: &str,
) -> CaptureSessionStart {
    let video_media_type_index = optional_u32(params, "videoMediaTypeIndex")
        .ok()
        .flatten()
        .or_else(|| optional_u32(params, "mediaTypeIndex").ok().flatten())
        .unwrap_or(0);
    let audio_index = optional_u32(params, "audioIndex")
        .ok()
        .flatten()
        .unwrap_or(0);

    let Ok(_com) = ComApartment::initialize() else {
        return mock_capture_session_start(
            requested_channels,
            started_at,
            "com-initialization-failed",
        );
    };

    let video_result = with_video_device_activates(|records| {
        build_video_session_start(records, requested_channels, video_media_type_index)
    });
    let audio_result =
        with_audio_capture_devices(|records| build_audio_session_start(records, audio_index));

    let (video_channels, video_devices, media_foundation_diag, bound_video_channels) =
        match video_result {
            Ok(result) => result,
            Err(error) => {
                let channels = requested_channels
                    .iter()
                    .enumerate()
                    .map(|(index, channel_id)| unassigned_video_channel(channel_id, index, &error))
                    .collect::<Vec<_>>();
                (
                    channels,
                    Vec::new(),
                    json!({
                        "status": "failed",
                        "backend": "media-foundation",
                        "error": error
                    }),
                    0usize,
                )
            }
        };

    let (audio, audio_devices, wasapi_diag, bound_audio_endpoints) = match audio_result {
        Ok(result) => result,
        Err(error) => (
            json!({
                "state": "unavailable",
                "source": "wasapi",
                "realCapture": false,
                "reason": error
            }),
            Vec::new(),
            json!({
                "status": "failed",
                "backend": "wasapi",
                "error": error
            }),
            0usize,
        ),
    };

    let unassigned_video_channels = video_channels
        .iter()
        .filter(|channel| channel.get("source").and_then(Value::as_str) == Some("unassigned"))
        .count();
    let device_snapshot = json!({
        "source": "windows-native",
        "video": video_devices,
        "audio": audio_devices,
        "diagnostics": {
            "workerDeviceMode": "windows-native",
            "mediaFoundation": media_foundation_diag,
            "wasapi": wasapi_diag
        }
    });
    let capture_session = json!({
        "state": "running",
        "mode": "windows-native",
        "realMediaSession": bound_video_channels > 0 || bound_audio_endpoints > 0,
        "startedAt": started_at,
        "videoMediaTypeIndex": video_media_type_index,
        "audioIndex": audio_index,
        "requestedChannelCount": requested_channels.len(),
        "boundVideoChannels": bound_video_channels,
        "unassignedVideoChannels": unassigned_video_channels,
        "boundAudioEndpoints": bound_audio_endpoints,
        "audio": audio,
        "mediaPayloadTransport": "native-only",
        "continuousVideoThreads": "not-started",
        "continuousVideoThreadCount": 0,
        "continuousAudioThreads": "not-started",
        "previewStatus": "not-rendered",
        "livekitStatus": "not-published",
        "recordingStatus": "idle",
        "diagnostics": device_snapshot["diagnostics"].clone()
    });
    let stats = json!({
        "uptimeMs": 0,
        "framesProduced": 0,
        "videoBytesCaptured": 0,
        "videoCaptureThreadCount": 0,
        "videoCaptureThreads": [],
        "videoFrameQueuePushCount": 0,
        "videoFrameQueueDropCount": 0,
        "audioPacketsProduced": 0,
        "audioFramesCaptured": 0,
        "audioBytesCaptured": 0,
        "syntheticFramesProduced": 0,
        "boundVideoChannels": bound_video_channels,
        "unassignedVideoChannels": unassigned_video_channels,
        "boundAudioEndpoints": bound_audio_endpoints,
        "realMediaSession": capture_session["realMediaSession"].clone()
    });

    CaptureSessionStart {
        channels: video_channels,
        device_snapshot,
        capture_session,
        stats,
    }
}

fn build_video_session_start(
    records: Vec<VideoDeviceActivate>,
    requested_channels: &[String],
    media_type_index: u32,
) -> Result<(Vec<Value>, Vec<Value>, Value, usize), String> {
    let devices = records
        .iter()
        .map(video_device_record_to_json)
        .collect::<Vec<_>>();
    let mut bound_count = 0usize;
    let channels = requested_channels
        .iter()
        .enumerate()
        .map(|(index, channel_id)| {
            let Some(record) = records.get(index) else {
                return unassigned_video_channel(
                    channel_id,
                    index,
                    "no-native-video-device-for-channel-index",
                );
            };
            bound_count += 1;
            let media_type = read_video_media_type_for_record(record, media_type_index);
            let (state, media_type_value, media_error) = match media_type {
                Ok(value) => ("native-bound", value, Value::Null),
                Err(error) => ("device-bound", Value::Null, json!(error)),
            };
            let width = media_type_value
                .get("width")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let height = media_type_value
                .get("height")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let frame_rate = media_type_value
                .get("frameRate")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            json!({
                "channelId": channel_id,
                "state": state,
                "source": "windows-native",
                "trackName": format!("video:{channel_id}"),
                "width": width,
                "height": height,
                "frameRate": frame_rate,
                "priority": index + 1,
                "device": video_device_record_to_json(record),
                "mediaType": media_type_value,
                "mediaTypeError": media_error,
                "realCapture": true,
                "payloadTransport": "native-only",
                "previewStatus": "not-rendered",
                "publisherStatus": "not-published",
                "recordingStatus": "idle",
                "statsStatus": "not-started"
            })
        })
        .collect::<Vec<_>>();
    let diag = json!({
        "status": "ok",
        "backend": "media-foundation",
        "count": devices.len(),
        "sessionBindingStatus": "bound",
        "capabilitiesStatus": "default-media-type-probed"
    });
    Ok((channels, devices, diag, bound_count))
}

fn build_audio_session_start(
    records: Vec<AudioDeviceRecord>,
    audio_index: u32,
) -> Result<(Value, Vec<Value>, Value, usize), String> {
    let devices = records
        .iter()
        .map(audio_device_record_to_json)
        .collect::<Vec<_>>();
    let Some(record) = records.iter().find(|record| record.index == audio_index) else {
        return Ok((
            json!({
                "state": "waiting-for-device",
                "source": "unassigned",
                "realCapture": false,
                "reason": format!("Audio index not found: {audio_index}")
            }),
            devices.clone(),
            json!({
                "status": "ok",
                "backend": "wasapi",
                "count": devices.len(),
                "sessionBindingStatus": "audio-unassigned",
                "capabilitiesStatus": "not-enumerated"
            }),
            0,
        ));
    };

    let format_probe = probe_audio_record_format(record);
    let (state, mix_format, device_period, error) = match format_probe {
        Ok(value) => (
            "native-bound",
            value.get("mixFormat").cloned().unwrap_or(Value::Null),
            value.get("devicePeriod").cloned().unwrap_or(Value::Null),
            Value::Null,
        ),
        Err(error) => ("device-bound", Value::Null, Value::Null, json!(error)),
    };
    Ok((
        json!({
            "state": state,
            "source": "windows-native",
            "device": audio_device_record_to_json(record),
            "mixFormat": mix_format,
            "devicePeriod": device_period,
            "formatError": error,
            "realCapture": true,
            "payloadTransport": "native-only",
            "aecStatus": "not-started",
            "publisherStatus": "not-published",
            "recordingStatus": "idle",
            "statsStatus": "not-started"
        }),
        devices.clone(),
        json!({
            "status": "ok",
            "backend": "wasapi",
            "count": devices.len(),
            "sessionBindingStatus": "bound",
            "capabilitiesStatus": "mix-format-probed"
        }),
        1,
    ))
}

fn unassigned_video_channel(channel_id: &str, index: usize, reason: &str) -> Value {
    json!({
        "channelId": channel_id,
        "state": "waiting-for-device",
        "source": "unassigned",
        "trackName": format!("video:{channel_id}"),
        "width": Value::Null,
        "height": Value::Null,
        "frameRate": Value::Null,
        "priority": index + 1,
        "device": Value::Null,
        "mediaType": Value::Null,
        "realCapture": false,
        "reason": reason,
        "payloadTransport": "none",
        "previewStatus": "not-rendered",
        "publisherStatus": "not-published",
        "recordingStatus": "idle",
        "statsStatus": "not-started"
    })
}

fn mock_capture_session_start(
    requested_channels: &[String],
    started_at: &str,
    reason: &str,
) -> CaptureSessionStart {
    let channels = requested_channels
        .iter()
        .enumerate()
        .map(|(index, channel_id)| {
            json!({
                "channelId": channel_id,
                "state": "previewing",
                "source": "mock-native",
                "trackName": format!("video:{channel_id}"),
                "width": 1920,
                "height": 1080,
                "frameRate": 30,
                "priority": index + 1,
                "realCapture": false,
                "payloadTransport": "none",
                "previewStatus": "mock",
                "publisherStatus": "not-published",
                "recordingStatus": "idle",
                "statsStatus": "mock"
            })
        })
        .collect::<Vec<_>>();
    let device_snapshot = mock_devices();
    let capture_session = json!({
        "state": "running",
        "mode": "mock-fallback",
        "realMediaSession": false,
        "startedAt": started_at,
        "reason": reason,
        "requestedChannelCount": requested_channels.len(),
        "boundVideoChannels": 0,
        "unassignedVideoChannels": 0,
        "boundAudioEndpoints": 0,
        "audio": Value::Null,
        "mediaPayloadTransport": "none",
        "continuousVideoThreads": "not-started",
        "continuousVideoThreadCount": 0,
        "continuousAudioThreads": "not-started",
        "previewStatus": "mock",
        "livekitStatus": "not-published",
        "recordingStatus": "idle"
    });
    let stats = json!({
        "uptimeMs": 0,
        "framesProduced": 0,
        "videoBytesCaptured": 0,
        "videoCaptureThreadCount": 0,
        "videoCaptureThreads": [],
        "videoFrameQueuePushCount": 0,
        "videoFrameQueueDropCount": 0,
        "audioPacketsProduced": 0,
        "audioFramesCaptured": 0,
        "audioBytesCaptured": 0,
        "syntheticFramesProduced": 0,
        "boundVideoChannels": 0,
        "unassignedVideoChannels": 0,
        "boundAudioEndpoints": 0,
        "realMediaSession": false
    });
    CaptureSessionStart {
        channels,
        device_snapshot,
        capture_session,
        stats,
    }
}

fn mark_channel_stats_status(channels: &mut [Value], channel_id: &str, status: &str) {
    for channel in channels {
        if channel.get("channelId").and_then(Value::as_str) == Some(channel_id) {
            channel["statsStatus"] = json!(status);
            return;
        }
    }
}

fn video_thread_start_targets(channels: &[Value], params: &Value) -> Vec<(String, u32)> {
    let enabled = params
        .get("startVideoThread")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !enabled {
        return Vec::new();
    }
    let limit = optional_u32(params, "videoThreadLimit")
        .ok()
        .flatten()
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(usize::MAX);
    channels
        .iter()
        .filter_map(|channel| {
            if channel.get("source").and_then(Value::as_str) != Some("windows-native") {
                return None;
            }
            let channel_id = channel.get("channelId")?.as_str()?.to_string();
            let video_index = channel
                .get("device")
                .and_then(|device| device.get("index"))
                .and_then(Value::as_u64)
                .or_else(|| {
                    channel
                        .get("priority")
                        .and_then(Value::as_u64)?
                        .checked_sub(1)
                })
                .and_then(|value| u32::try_from(value).ok())?;
            Some((channel_id, video_index))
        })
        .take(limit)
        .collect()
}

fn start_video_capture_runtime(
    channel_id: String,
    video_index: u32,
    media_type_index: u32,
    frame_queue_capacity: u32,
) -> VideoCaptureRuntime {
    let stop = Arc::new(AtomicBool::new(false));
    let stats = Arc::new(Mutex::new(VideoCaptureThreadStats::new(
        channel_id.clone(),
        video_index,
        media_type_index,
        frame_queue_capacity,
    )));
    let thread_stop = Arc::clone(&stop);
    let thread_stats = Arc::clone(&stats);
    let handle = thread::spawn(move || {
        run_video_capture_thread(
            channel_id,
            video_index,
            media_type_index,
            frame_queue_capacity,
            thread_stop,
            thread_stats,
        );
    });
    VideoCaptureRuntime {
        stop,
        stats,
        handle: Some(handle),
    }
}

fn stop_video_capture_runtimes(state: &mut WorkerState) -> Vec<Value> {
    let mut snapshots = Vec::new();
    for mut runtime in std::mem::take(&mut state.video_runtimes) {
        runtime.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = runtime.handle.take() {
            if handle.join().is_err() {
                runtime.update(|stats| {
                    stats.state = "failed".to_string();
                    stats.stopped_at = Some(now_iso_like());
                    stats.last_error = Some("video capture thread panicked".to_string());
                });
            }
        }
        snapshots.push(runtime.snapshot());
    }
    snapshots
}

fn run_video_capture_thread(
    _channel_id: String,
    video_index: u32,
    media_type_index: u32,
    _frame_queue_capacity: u32,
    stop: Arc<AtomicBool>,
    stats: Arc<Mutex<VideoCaptureThreadStats>>,
) {
    let started = Instant::now();
    update_video_stats(&stats, |stats| {
        stats.state = "initializing".to_string();
    });
    let result = (|| {
        let _com = ComApartment::initialize()?;
        with_video_device_activates(|records| {
            let record = records
                .iter()
                .find(|record| record.index == video_index)
                .ok_or_else(|| format!("Video index not found: {video_index}"))?;
            let source: IMFMediaSource = unsafe {
                record
                    .activate
                    .ActivateObject()
                    .map_err(format_windows_error)?
            };
            let result = (|| {
                let reader = unsafe {
                    MFCreateSourceReaderFromMediaSource(&source, None::<&IMFAttributes>)
                        .map_err(format_windows_error)?
                };
                let media_type = unsafe {
                    reader
                        .GetNativeMediaType(video_stream_index(), media_type_index)
                        .map_err(format_windows_error)?
                };
                unsafe {
                    reader
                        .SetCurrentMediaType(video_stream_index(), None, &media_type)
                        .map_err(format_windows_error)?;
                }
                let media_type_json = media_type_to_json(&media_type, media_type_index);
                update_video_stats(&stats, |stats| {
                    stats.state = "running".to_string();
                    stats.elapsed_ms = started.elapsed().as_millis();
                    stats.device = video_device_record_to_json(record);
                    stats.media_type = media_type_json.clone();
                });

                while !stop.load(Ordering::SeqCst) {
                    let mut actual_stream_index = 0u32;
                    let mut stream_flags = 0u32;
                    let mut timestamp_hns = 0i64;
                    let mut sample = None;
                    unsafe {
                        reader
                            .ReadSample(
                                video_stream_index(),
                                0,
                                Some(&mut actual_stream_index),
                                Some(&mut stream_flags),
                                Some(&mut timestamp_hns),
                                Some(&mut sample),
                            )
                            .map_err(format_windows_error)?;
                    }
                    if has_source_reader_flag(stream_flags, MF_SOURCE_READERF_ERROR.0) {
                        return Err(format!(
                            "SourceReader reported error flag while running video thread. flags={stream_flags}"
                        ));
                    }
                    if has_source_reader_flag(stream_flags, MF_SOURCE_READERF_ENDOFSTREAM.0) {
                        return Err(format!(
                            "SourceReader reached end of stream while running video thread"
                        ));
                    }
                    update_video_stats(&stats, |stats| {
                        stats.read_count = stats.read_count.saturating_add(1);
                        stats.stream_flags_or |= stream_flags;
                        if has_source_reader_flag(
                            stream_flags,
                            MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0,
                        ) {
                            stats.media_type_changed_count =
                                stats.media_type_changed_count.saturating_add(1);
                        }
                        if has_source_reader_flag(
                            stream_flags,
                            MF_SOURCE_READERF_NATIVEMEDIATYPECHANGED.0,
                        ) {
                            stats.native_media_type_changed_count =
                                stats.native_media_type_changed_count.saturating_add(1);
                        }
                        stats.elapsed_ms = started.elapsed().as_millis();
                    });

                    if let Some(sample) = sample {
                        update_video_stats(&stats, |stats| {
                            stats.sample_count = stats.sample_count.saturating_add(1);
                            stats.first_timestamp_hns.get_or_insert(timestamp_hns);
                            stats.last_timestamp_hns = Some(timestamp_hns);
                            let total_length = unsafe { sample.GetTotalLength().ok() };
                            if let Some(total_length) = total_length {
                                stats.total_length_bytes = stats
                                    .total_length_bytes
                                    .saturating_add(u64::from(total_length));
                            }
                            if let Ok(buffer_count) = unsafe { sample.GetBufferCount() } {
                                stats.total_buffer_count = stats
                                    .total_buffer_count
                                    .saturating_add(u64::from(buffer_count));
                            }
                            let sample_time_hns = unsafe { sample.GetSampleTime().ok() };
                            if let Some(sample_time_hns) = sample_time_hns {
                                stats.first_sample_time_hns.get_or_insert(sample_time_hns);
                                stats.last_sample_time_hns = Some(sample_time_hns);
                            }
                            if let Ok(sample_duration_hns) = unsafe { sample.GetSampleDuration() } {
                                stats.sample_duration_sum_hns += i128::from(sample_duration_hns);
                                stats.sample_duration_count =
                                    stats.sample_duration_count.saturating_add(1);
                            }
                            stats.frame_queue_push_count =
                                stats.frame_queue_push_count.saturating_add(1);
                            stats.frame_queue_latest_sequence = Some(stats.sample_count);
                            stats.frame_queue_latest_timestamp_hns = Some(timestamp_hns);
                            stats.frame_queue_latest_sample_time_hns = sample_time_hns;
                            stats.frame_queue_latest_total_length_bytes = total_length;
                            if stats.frame_queue_depth < stats.frame_queue_capacity {
                                stats.frame_queue_depth = stats.frame_queue_depth.saturating_add(1);
                            } else {
                                stats.frame_queue_drop_count =
                                    stats.frame_queue_drop_count.saturating_add(1);
                            }
                            stats.elapsed_ms = started.elapsed().as_millis();
                        });
                    } else {
                        update_video_stats(&stats, |stats| {
                            stats.empty_read_count = stats.empty_read_count.saturating_add(1);
                            stats.elapsed_ms = started.elapsed().as_millis();
                        });
                        thread::sleep(Duration::from_millis(1));
                    }
                }
                Ok::<(), String>(())
            })();
            shutdown_media_source(&source, &record.activate);
            result
        })
    })();

    match result {
        Ok(()) => {
            update_video_stats(&stats, |stats| {
                stats.state = "stopped".to_string();
                stats.stopped_at = Some(now_iso_like());
                stats.elapsed_ms = started.elapsed().as_millis();
            });
        }
        Err(error) => {
            update_video_stats(&stats, |stats| {
                stats.state = "failed".to_string();
                stats.stopped_at = Some(now_iso_like());
                stats.elapsed_ms = started.elapsed().as_millis();
                stats.last_error = Some(error);
            });
        }
    }
}

fn update_video_stats(
    stats: &Arc<Mutex<VideoCaptureThreadStats>>,
    update: impl FnOnce(&mut VideoCaptureThreadStats),
) {
    if let Ok(mut stats) = stats.lock() {
        update(&mut stats);
    }
}

impl VideoCaptureRuntime {
    fn snapshot(&self) -> Value {
        self.stats
            .lock()
            .map(|stats| video_capture_thread_stats_to_json(&stats))
            .unwrap_or_else(|_| {
                json!({
                    "state": "failed",
                    "lastError": "video capture stats lock poisoned"
                })
            })
    }

    fn update(&self, update: impl FnOnce(&mut VideoCaptureThreadStats)) {
        update_video_stats(&self.stats, update);
    }
}

impl VideoCaptureThreadStats {
    fn new(
        channel_id: String,
        device_index: u32,
        media_type_index: u32,
        frame_queue_capacity: u32,
    ) -> Self {
        Self {
            state: "starting".to_string(),
            started_at: now_iso_like(),
            stopped_at: None,
            elapsed_ms: 0,
            channel_id,
            device_index,
            media_type_index,
            frame_queue_capacity,
            frame_queue_depth: 0,
            frame_queue_push_count: 0,
            frame_queue_drop_count: 0,
            frame_queue_latest_sequence: None,
            frame_queue_latest_timestamp_hns: None,
            frame_queue_latest_sample_time_hns: None,
            frame_queue_latest_total_length_bytes: None,
            read_count: 0,
            sample_count: 0,
            empty_read_count: 0,
            total_length_bytes: 0,
            total_buffer_count: 0,
            stream_flags_or: 0,
            media_type_changed_count: 0,
            native_media_type_changed_count: 0,
            first_timestamp_hns: None,
            last_timestamp_hns: None,
            first_sample_time_hns: None,
            last_sample_time_hns: None,
            sample_duration_sum_hns: 0,
            sample_duration_count: 0,
            device: Value::Null,
            media_type: Value::Null,
            last_error: None,
        }
    }
}

fn should_start_audio_thread(params: &Value, capture_session: &Value) -> bool {
    let enabled = params
        .get("startAudioThread")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let bound_audio = capture_session
        .get("boundAudioEndpoints")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        > 0;
    enabled && bound_audio
}

fn start_audio_capture_runtime(audio_index: u32, poll_interval_ms: u32) -> AudioCaptureRuntime {
    let stop = Arc::new(AtomicBool::new(false));
    let stats = Arc::new(Mutex::new(AudioCaptureThreadStats::new(
        audio_index,
        poll_interval_ms,
    )));
    let thread_stop = Arc::clone(&stop);
    let thread_stats = Arc::clone(&stats);
    let handle = thread::spawn(move || {
        run_audio_capture_thread(audio_index, poll_interval_ms, thread_stop, thread_stats);
    });
    AudioCaptureRuntime {
        stop,
        stats,
        handle: Some(handle),
    }
}

fn stop_audio_capture_runtime(state: &mut WorkerState) -> Option<Value> {
    let mut runtime = state.audio_runtime.take()?;
    runtime.stop.store(true, Ordering::SeqCst);
    if let Some(handle) = runtime.handle.take() {
        if handle.join().is_err() {
            runtime.update(|stats| {
                stats.state = "failed".to_string();
                stats.stopped_at = Some(now_iso_like());
                stats.last_error = Some("audio capture thread panicked".to_string());
            });
        }
    }
    Some(runtime.snapshot())
}

fn run_audio_capture_thread(
    audio_index: u32,
    poll_interval_ms: u32,
    stop: Arc<AtomicBool>,
    stats: Arc<Mutex<AudioCaptureThreadStats>>,
) {
    let started = Instant::now();
    update_audio_stats(&stats, |stats| {
        stats.state = "initializing".to_string();
    });
    let result = (|| {
        let _com = ComApartment::initialize()?;
        with_audio_capture_devices(|records| {
            let record = records
                .iter()
                .find(|record| record.index == audio_index)
                .ok_or_else(|| format!("Audio index not found: {audio_index}"))?;
            let audio_client: IAudioClient = unsafe {
                record
                    .device
                    .Activate(CLSCTX_ALL, None)
                    .map_err(format_windows_error)?
            };
            with_audio_mix_format(&audio_client, |format_ptr| {
                let mix_format = wave_format_to_json(format_ptr)?;
                let format = unsafe { *format_ptr };
                let block_align = u64::from(format.nBlockAlign.max(1));
                update_audio_stats(&stats, |stats| {
                    stats.state = "starting".to_string();
                    stats.device = audio_device_record_to_json(record);
                    stats.mix_format = mix_format.clone();
                });
                unsafe {
                    audio_client
                        .Initialize(
                            AUDCLNT_SHAREMODE_SHARED,
                            0,
                            500 * 10_000,
                            0,
                            format_ptr,
                            None,
                        )
                        .map_err(format_windows_error)?;
                }
                let buffer_frame_capacity = unsafe { audio_client.GetBufferSize().ok() };
                let stream_latency_hns = unsafe { audio_client.GetStreamLatency().ok() };
                let capture_client: IAudioCaptureClient =
                    unsafe { audio_client.GetService().map_err(format_windows_error)? };
                unsafe {
                    audio_client.Start().map_err(format_windows_error)?;
                }
                update_audio_stats(&stats, |stats| {
                    stats.state = "running".to_string();
                    stats.buffer_frame_capacity = buffer_frame_capacity;
                    stats.stream_latency_hns = stream_latency_hns;
                    stats.elapsed_ms = started.elapsed().as_millis();
                });

                let capture_result = (|| {
                    while !stop.load(Ordering::SeqCst) {
                        let mut packet_size = unsafe {
                            capture_client
                                .GetNextPacketSize()
                                .map_err(format_windows_error)?
                        };
                        update_audio_stats(&stats, |stats| {
                            stats.poll_count = stats.poll_count.saturating_add(1);
                            stats.elapsed_ms = started.elapsed().as_millis();
                        });
                        while packet_size > 0 {
                            let mut data_ptr: *mut u8 = ptr::null_mut();
                            let mut frames_to_read = 0u32;
                            let mut flags = 0u32;
                            let mut device_position = 0u64;
                            let mut qpc_position = 0u64;
                            unsafe {
                                capture_client
                                    .GetBuffer(
                                        &mut data_ptr,
                                        &mut frames_to_read,
                                        &mut flags,
                                        Some(&mut device_position),
                                        Some(&mut qpc_position),
                                    )
                                    .map_err(format_windows_error)?;
                            }
                            update_audio_stats(&stats, |stats| {
                                let frame_count = u64::from(frames_to_read);
                                stats.packet_count = stats.packet_count.saturating_add(1);
                                stats.captured_frames =
                                    stats.captured_frames.saturating_add(frame_count);
                                stats.captured_bytes = stats
                                    .captured_bytes
                                    .saturating_add(frame_count.saturating_mul(block_align));
                                if has_audio_buffer_flag(flags, AUDCLNT_BUFFERFLAGS_SILENT.0) {
                                    stats.silent_packets = stats.silent_packets.saturating_add(1);
                                }
                                if has_audio_buffer_flag(
                                    flags,
                                    AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0,
                                ) {
                                    stats.discontinuity_packets =
                                        stats.discontinuity_packets.saturating_add(1);
                                }
                                if has_audio_buffer_flag(
                                    flags,
                                    AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0,
                                ) {
                                    stats.timestamp_error_packets =
                                        stats.timestamp_error_packets.saturating_add(1);
                                }
                                stats.last_device_position = Some(device_position);
                                stats.last_qpc_position = Some(qpc_position);
                                stats.elapsed_ms = started.elapsed().as_millis();
                            });
                            unsafe {
                                capture_client
                                    .ReleaseBuffer(frames_to_read)
                                    .map_err(format_windows_error)?;
                            }
                            packet_size = unsafe {
                                capture_client
                                    .GetNextPacketSize()
                                    .map_err(format_windows_error)?
                            };
                        }
                        thread::sleep(Duration::from_millis(u64::from(poll_interval_ms)));
                    }
                    Ok::<(), String>(())
                })();
                let stop_result = unsafe { audio_client.Stop().map_err(format_windows_error) };
                match (capture_result, stop_result) {
                    (Ok(()), Ok(())) => Ok(()),
                    (Err(error), _) => Err(error),
                    (Ok(()), Err(error)) => Err(error),
                }
            })
        })
    })();

    match result {
        Ok(()) => {
            update_audio_stats(&stats, |stats| {
                stats.state = "stopped".to_string();
                stats.stopped_at = Some(now_iso_like());
                stats.elapsed_ms = started.elapsed().as_millis();
            });
        }
        Err(error) => {
            update_audio_stats(&stats, |stats| {
                stats.state = "failed".to_string();
                stats.stopped_at = Some(now_iso_like());
                stats.elapsed_ms = started.elapsed().as_millis();
                stats.last_error = Some(error);
            });
        }
    }
}

fn update_audio_stats(
    stats: &Arc<Mutex<AudioCaptureThreadStats>>,
    update: impl FnOnce(&mut AudioCaptureThreadStats),
) {
    if let Ok(mut stats) = stats.lock() {
        update(&mut stats);
    }
}

impl AudioCaptureRuntime {
    fn snapshot(&self) -> Value {
        self.stats
            .lock()
            .map(|stats| audio_capture_thread_stats_to_json(&stats))
            .unwrap_or_else(|_| {
                json!({
                    "state": "failed",
                    "lastError": "audio capture stats lock poisoned"
                })
            })
    }

    fn update(&self, update: impl FnOnce(&mut AudioCaptureThreadStats)) {
        update_audio_stats(&self.stats, update);
    }
}

impl AudioCaptureThreadStats {
    fn new(device_index: u32, poll_interval_ms: u32) -> Self {
        Self {
            state: "starting".to_string(),
            started_at: now_iso_like(),
            stopped_at: None,
            elapsed_ms: 0,
            device_index,
            poll_interval_ms,
            packet_count: 0,
            captured_frames: 0,
            captured_bytes: 0,
            silent_packets: 0,
            discontinuity_packets: 0,
            timestamp_error_packets: 0,
            poll_count: 0,
            last_device_position: None,
            last_qpc_position: None,
            buffer_frame_capacity: None,
            stream_latency_hns: None,
            device: Value::Null,
            mix_format: Value::Null,
            last_error: None,
        }
    }
}

fn stats_with_runtimes(
    base_stats: &Value,
    audio_runtime: Option<&AudioCaptureRuntime>,
    video_runtimes: &[VideoCaptureRuntime],
) -> Value {
    let mut stats = base_stats.clone();
    if let Some(runtime) = audio_runtime {
        let audio_stats = runtime.snapshot();
        stats["audioCaptureThread"] = audio_stats.clone();
        stats["audioPacketsProduced"] = audio_stats
            .get("packetCount")
            .cloned()
            .unwrap_or_else(|| json!(0));
        stats["audioFramesCaptured"] = audio_stats
            .get("capturedFrames")
            .cloned()
            .unwrap_or_else(|| json!(0));
        stats["audioBytesCaptured"] = audio_stats
            .get("capturedBytes")
            .cloned()
            .unwrap_or_else(|| json!(0));
    }
    if !video_runtimes.is_empty() {
        let video_stats = video_runtimes
            .iter()
            .map(VideoCaptureRuntime::snapshot)
            .collect::<Vec<_>>();
        let frames_produced = video_stats
            .iter()
            .filter_map(|stats| stats.get("sampleCount").and_then(Value::as_u64))
            .sum::<u64>();
        let video_bytes_captured = video_stats
            .iter()
            .filter_map(|stats| stats.get("totalLengthBytes").and_then(Value::as_u64))
            .sum::<u64>();
        let frame_queue_push_count = video_stats
            .iter()
            .filter_map(|stats| {
                stats
                    .get("frameQueue")
                    .and_then(|queue| queue.get("pushCount"))
                    .and_then(Value::as_u64)
            })
            .sum::<u64>();
        let frame_queue_drop_count = video_stats
            .iter()
            .filter_map(|stats| {
                stats
                    .get("frameQueue")
                    .and_then(|queue| queue.get("dropCount"))
                    .and_then(Value::as_u64)
            })
            .sum::<u64>();
        if let Some(first_video_stats) = video_stats.first() {
            stats["videoCaptureThread"] = first_video_stats.clone();
        }
        stats["videoCaptureThreads"] = Value::Array(video_stats);
        stats["videoCaptureThreadCount"] = json!(video_runtimes.len());
        stats["framesProduced"] = json!(frames_produced);
        stats["videoBytesCaptured"] = json!(video_bytes_captured);
        stats["videoFrameQueuePushCount"] = json!(frame_queue_push_count);
        stats["videoFrameQueueDropCount"] = json!(frame_queue_drop_count);
    }
    stats
}

fn audio_capture_thread_stats_to_json(stats: &AudioCaptureThreadStats) -> Value {
    json!({
        "state": stats.state,
        "startedAt": stats.started_at,
        "stoppedAt": stats.stopped_at,
        "elapsedMs": stats.elapsed_ms,
        "deviceIndex": stats.device_index,
        "pollIntervalMs": stats.poll_interval_ms,
        "packetCount": stats.packet_count,
        "capturedFrames": stats.captured_frames,
        "capturedBytes": stats.captured_bytes,
        "silentPackets": stats.silent_packets,
        "discontinuityPackets": stats.discontinuity_packets,
        "timestampErrorPackets": stats.timestamp_error_packets,
        "pollCount": stats.poll_count,
        "lastDevicePosition": stats.last_device_position,
        "lastQpcPosition": stats.last_qpc_position,
        "bufferFrameCapacity": stats.buffer_frame_capacity,
        "streamLatencyHns": stats.stream_latency_hns,
        "device": stats.device,
        "mixFormat": stats.mix_format,
        "lastError": stats.last_error
    })
}

fn video_capture_thread_stats_to_json(stats: &VideoCaptureThreadStats) -> Value {
    let measured_fps = if stats.elapsed_ms > 0 {
        Some(stats.sample_count as f64 * 1000.0 / stats.elapsed_ms as f64)
    } else {
        None
    };
    let measured_bytes_per_second = if stats.elapsed_ms > 0 {
        Some(stats.total_length_bytes as f64 * 1000.0 / stats.elapsed_ms as f64)
    } else {
        None
    };
    let average_sample_duration_hns = if stats.sample_duration_count > 0 {
        Some((stats.sample_duration_sum_hns / i128::from(stats.sample_duration_count)) as i64)
    } else {
        None
    };
    let frame_rate_from_duration = average_sample_duration_hns
        .filter(|duration| *duration > 0)
        .map(|duration| 10_000_000.0 / duration as f64);
    let media_time_span_hns = stats
        .first_sample_time_hns
        .zip(stats.last_sample_time_hns)
        .and_then(|(first, last)| last.checked_sub(first));
    let media_timeline_fps = media_time_span_hns
        .filter(|span| *span > 0 && stats.sample_count > 1)
        .map(|span| (stats.sample_count - 1) as f64 * 10_000_000.0 / span as f64);

    json!({
        "state": stats.state,
        "startedAt": stats.started_at,
        "stoppedAt": stats.stopped_at,
        "elapsedMs": stats.elapsed_ms,
        "channelId": stats.channel_id,
        "deviceIndex": stats.device_index,
        "mediaTypeIndex": stats.media_type_index,
        "frameQueue": {
            "mode": "metadata-only-bounded",
            "payloadTransport": "native-only",
            "consumerStatus": "not-attached",
            "capacity": stats.frame_queue_capacity,
            "depth": stats.frame_queue_depth,
            "pushCount": stats.frame_queue_push_count,
            "dropCount": stats.frame_queue_drop_count,
            "latestSequence": stats.frame_queue_latest_sequence,
            "latestTimestampHns": stats.frame_queue_latest_timestamp_hns,
            "latestSampleTimeHns": stats.frame_queue_latest_sample_time_hns,
            "latestTotalLengthBytes": stats.frame_queue_latest_total_length_bytes
        },
        "readCount": stats.read_count,
        "sampleCount": stats.sample_count,
        "emptyReadCount": stats.empty_read_count,
        "measuredFps": measured_fps,
        "mediaTimelineFps": media_timeline_fps,
        "measuredBytesPerSecond": measured_bytes_per_second,
        "totalLengthBytes": stats.total_length_bytes,
        "totalBufferCount": stats.total_buffer_count,
        "averageSampleDurationHns": average_sample_duration_hns,
        "frameRateFromSampleDuration": frame_rate_from_duration,
        "firstTimestampHns": stats.first_timestamp_hns,
        "lastTimestampHns": stats.last_timestamp_hns,
        "firstSampleTimeHns": stats.first_sample_time_hns,
        "lastSampleTimeHns": stats.last_sample_time_hns,
        "mediaTimeSpanHns": media_time_span_hns,
        "streamFlagsOr": stats.stream_flags_or,
        "streamFlagNames": source_reader_flag_names(stats.stream_flags_or),
        "mediaTypeChangedCount": stats.media_type_changed_count,
        "nativeMediaTypeChangedCount": stats.native_media_type_changed_count,
        "device": stats.device,
        "mediaType": stats.media_type,
        "lastError": stats.last_error
    })
}

fn mock_devices() -> Value {
    json!({
        "source": "mock-native",
        "video": [
            {
                "deviceId": "mock-native-video-panorama",
                "displayName": "Mock Native USB Capture - Panorama",
                "transport": "usb",
                "role": "panorama",
                "backend": "mock-native",
                "nativeId": "mock-native-video-panorama",
                "capabilities": [{ "width": 1920, "height": 1080, "frameRate": 30 }]
            },
            {
                "deviceId": "mock-native-video-field",
                "displayName": "Mock Native USB Capture - Surgical Field",
                "transport": "usb",
                "role": "field",
                "backend": "mock-native",
                "nativeId": "mock-native-video-field",
                "capabilities": [{ "width": 1920, "height": 1080, "frameRate": 30 }]
            },
            {
                "deviceId": "mock-native-video-endoscope",
                "displayName": "Mock Native USB Capture - Endoscope",
                "transport": "usb",
                "role": "endoscope",
                "backend": "mock-native",
                "nativeId": "mock-native-video-endoscope",
                "capabilities": [{ "width": 1920, "height": 1080, "frameRate": 30 }]
            },
            {
                "deviceId": "mock-native-video-device",
                "displayName": "Mock Native USB Capture - Medical Device",
                "transport": "usb",
                "role": "device",
                "backend": "mock-native",
                "nativeId": "mock-native-video-device",
                "capabilities": [{ "width": 1920, "height": 1080, "frameRate": 30 }]
            }
        ],
        "audio": [
            {
                "deviceId": "mock-native-audio-room",
                "displayName": "Mock Native USB Omnidirectional Microphone",
                "transport": "usb",
                "role": "room-microphone",
                "backend": "mock-native",
                "nativeId": "mock-native-audio-room",
                "capabilities": [{ "sampleRate": 48000, "channels": 2 }]
            }
        ],
        "diagnostics": {
            "workerDeviceMode": "mock-native",
            "mediaFoundation": { "status": "mock", "count": 4 },
            "wasapi": { "status": "mock", "count": 1 }
        }
    })
}

fn enumerate_native_devices() -> Value {
    let com = match ComApartment::initialize() {
        Ok(com) => com,
        Err(error) => {
            let mut devices = mock_devices();
            devices["source"] = json!("mock-fallback");
            devices["diagnostics"] = json!({
                "workerDeviceMode": "mock-fallback",
                "reason": "com-initialization-failed",
                "com": { "status": "failed", "error": error },
                "mediaFoundation": { "status": "not-run" },
                "wasapi": { "status": "not-run" }
            });
            return devices;
        }
    };

    let video_result = enumerate_video_devices();
    let audio_result = enumerate_audio_capture_devices();
    drop(com);

    let (video, media_foundation_diag) = match video_result {
        Ok(video) => {
            let count = video.len();
            (
                video,
                json!({
                    "status": "ok",
                    "count": count,
                    "backend": "media-foundation",
                    "capabilitiesStatus": "not-enumerated"
                }),
            )
        }
        Err(error) => (
            Vec::new(),
            json!({
                "status": "failed",
                "backend": "media-foundation",
                "error": error
            }),
        ),
    };

    let (audio, wasapi_diag) = match audio_result {
        Ok(audio) => {
            let count = audio.len();
            (
                audio,
                json!({
                    "status": "ok",
                    "count": count,
                    "backend": "wasapi",
                    "capabilitiesStatus": "not-enumerated"
                }),
            )
        }
        Err(error) => (
            Vec::new(),
            json!({
                "status": "failed",
                "backend": "wasapi",
                "error": error
            }),
        ),
    };

    let media_foundation_failed = media_foundation_diag["status"] == "failed";
    let wasapi_failed = wasapi_diag["status"] == "failed";
    if media_foundation_failed && wasapi_failed {
        let mut devices = mock_devices();
        devices["source"] = json!("mock-fallback");
        devices["diagnostics"] = json!({
            "workerDeviceMode": "mock-fallback",
            "reason": "native-enumeration-failed",
            "mediaFoundation": media_foundation_diag,
            "wasapi": wasapi_diag
        });
        return devices;
    }

    json!({
        "source": "windows-native",
        "video": video,
        "audio": audio,
        "diagnostics": {
            "workerDeviceMode": "windows-native",
            "mediaFoundation": media_foundation_diag,
            "wasapi": wasapi_diag
        }
    })
}

fn enumerate_video_devices() -> Result<Vec<Value>, String> {
    with_video_device_activates(|records| {
        Ok(records
            .iter()
            .map(video_device_record_to_json)
            .collect::<Vec<_>>())
    })
}

fn with_video_device_activates<T>(
    callback: impl FnOnce(Vec<VideoDeviceActivate>) -> Result<T, String>,
) -> Result<T, String> {
    let _mf = MediaFoundationSession::start()?;
    let mut attributes: Option<IMFAttributes> = None;
    unsafe {
        MFCreateAttributes(&mut attributes, 1).map_err(format_windows_error)?;
    }
    let attributes =
        attributes.ok_or_else(|| "MFCreateAttributes returned no attributes".to_string())?;

    unsafe {
        attributes
            .SetGUID(
                &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
            )
            .map_err(format_windows_error)?;
    }

    let mut activates_ptr: *mut Option<IMFActivate> = ptr::null_mut();
    let mut count = 0u32;
    unsafe {
        MFEnumDeviceSources(&attributes, &mut activates_ptr, &mut count)
            .map_err(format_windows_error)?;
    }

    let mut devices = Vec::new();
    for index in 0..count {
        let activate = unsafe { ptr::read(activates_ptr.add(index as usize)) };
        if let Some(activate) = activate {
            let display_name =
                get_mf_allocated_string(&activate, &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME)
                    .unwrap_or_else(|| format!("Media Foundation Video {}", index + 1));
            let native_id = get_mf_allocated_string(
                &activate,
                &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK,
            )
            .unwrap_or_else(|| format!("mf-video-{index}"));
            let device_id = stable_device_id("mf-video", index, &native_id);
            let role = DEFAULT_CHANNELS
                .get(index as usize)
                .copied()
                .unwrap_or("aux-device");
            let transport = infer_transport(&native_id, &display_name);
            devices.push(VideoDeviceActivate {
                index,
                device_id,
                display_name,
                native_id,
                role,
                transport,
                activate,
            });
        }
    }

    unsafe {
        CoTaskMemFree(Some(activates_ptr.cast()));
    }
    callback(devices)
}

fn video_device_record_to_json(record: &VideoDeviceActivate) -> Value {
    json!({
        "index": record.index,
        "deviceId": record.device_id,
        "displayName": record.display_name,
        "transport": record.transport,
        "role": record.role,
        "backend": "media-foundation",
        "nativeId": record.native_id,
        "state": "active",
        "capabilities": [],
        "capabilitiesStatus": "not-enumerated",
        "capabilityProbeRequired": true
    })
}

fn probe_video_capabilities(params: &Value) -> Result<Value, String> {
    let max_media_types = optional_u32(params, "maxMediaTypes")?
        .unwrap_or(128)
        .clamp(1, 512);
    with_video_device_activates(|records| {
        let selected = select_video_records(&records, params)?;
        let mut devices = Vec::new();
        for record in selected {
            devices.push(probe_video_record_capabilities(record, max_media_types)?);
        }
        Ok(json!({
            "status": "ok",
            "backend": "media-foundation",
            "deviceCount": devices.len(),
            "maxMediaTypes": max_media_types,
            "devices": devices
        }))
    })
}

fn capture_video_sample(params: &Value) -> Result<Value, String> {
    let media_type_index = optional_u32(params, "mediaTypeIndex")?.unwrap_or(0);
    let max_attempts = optional_u32(params, "maxAttempts")?
        .unwrap_or(60)
        .clamp(1, 300);
    with_video_device_activates(|records| {
        let selected = select_video_records(&records, params)?;
        let record = selected
            .first()
            .copied()
            .ok_or_else(|| "No video device selected".to_string())?;
        capture_video_sample_for_record(record, media_type_index, max_attempts)
    })
}

fn measure_video_frames(params: &Value) -> Result<Value, String> {
    let media_type_index = optional_u32(params, "mediaTypeIndex")?.unwrap_or(0);
    let duration_ms = optional_u32(params, "durationMs")?
        .unwrap_or(2_000)
        .clamp(250, 120_000);
    let max_reads = optional_u32(params, "maxReads")?
        .unwrap_or(10_000)
        .clamp(1, 1_000_000);
    with_video_device_activates(|records| {
        let selected = select_video_records(&records, params)?;
        let record = selected
            .first()
            .copied()
            .ok_or_else(|| "No video device selected".to_string())?;
        measure_video_frames_for_record(record, media_type_index, duration_ms, max_reads)
    })
}

fn probe_video_record_capabilities(
    record: &VideoDeviceActivate,
    max_media_types: u32,
) -> Result<Value, String> {
    let source: IMFMediaSource = unsafe {
        record
            .activate
            .ActivateObject()
            .map_err(format_windows_error)?
    };
    let result = (|| {
        let reader = unsafe {
            MFCreateSourceReaderFromMediaSource(&source, None::<&IMFAttributes>)
                .map_err(format_windows_error)?
        };
        let mut capabilities = Vec::new();
        let mut stop_reason = "max-media-types-reached".to_string();
        for media_type_index in 0..max_media_types {
            match unsafe { reader.GetNativeMediaType(video_stream_index(), media_type_index) } {
                Ok(media_type) => {
                    capabilities.push(media_type_to_json(&media_type, media_type_index));
                }
                Err(error) => {
                    stop_reason = if capabilities.is_empty() {
                        format!("first-media-type-error: {}", format_windows_error(error))
                    } else {
                        "no-more-media-types".to_string()
                    };
                    break;
                }
            }
        }
        Ok(json!({
            "device": video_device_record_to_json(record),
            "capabilitiesStatus": "enumerated",
            "capabilityCount": capabilities.len(),
            "stopReason": stop_reason,
            "capabilities": capabilities
        }))
    })();
    shutdown_media_source(&source, &record.activate);
    result
}

fn read_video_media_type_for_record(
    record: &VideoDeviceActivate,
    media_type_index: u32,
) -> Result<Value, String> {
    let source: IMFMediaSource = unsafe {
        record
            .activate
            .ActivateObject()
            .map_err(format_windows_error)?
    };
    let result = (|| {
        let reader = unsafe {
            MFCreateSourceReaderFromMediaSource(&source, None::<&IMFAttributes>)
                .map_err(format_windows_error)?
        };
        let media_type = unsafe {
            reader
                .GetNativeMediaType(video_stream_index(), media_type_index)
                .map_err(format_windows_error)?
        };
        Ok(media_type_to_json(&media_type, media_type_index))
    })();
    shutdown_media_source(&source, &record.activate);
    result
}

fn capture_video_sample_for_record(
    record: &VideoDeviceActivate,
    media_type_index: u32,
    max_attempts: u32,
) -> Result<Value, String> {
    let source: IMFMediaSource = unsafe {
        record
            .activate
            .ActivateObject()
            .map_err(format_windows_error)?
    };
    let result = (|| {
        let reader = unsafe {
            MFCreateSourceReaderFromMediaSource(&source, None::<&IMFAttributes>)
                .map_err(format_windows_error)?
        };
        let media_type = unsafe {
            reader
                .GetNativeMediaType(video_stream_index(), media_type_index)
                .map_err(format_windows_error)?
        };
        unsafe {
            reader
                .SetCurrentMediaType(video_stream_index(), None, &media_type)
                .map_err(format_windows_error)?;
        }

        let media_type_json = media_type_to_json(&media_type, media_type_index);
        let started_at = Instant::now();
        let mut last_flags = 0u32;
        for attempt in 1..=max_attempts {
            let mut actual_stream_index = 0u32;
            let mut stream_flags = 0u32;
            let mut timestamp_hns = 0i64;
            let mut sample = None;
            unsafe {
                reader
                    .ReadSample(
                        video_stream_index(),
                        0,
                        Some(&mut actual_stream_index),
                        Some(&mut stream_flags),
                        Some(&mut timestamp_hns),
                        Some(&mut sample),
                    )
                    .map_err(format_windows_error)?;
            }
            last_flags = stream_flags;

            if has_source_reader_flag(stream_flags, MF_SOURCE_READERF_ERROR.0) {
                return Err(format!(
                    "SourceReader reported error flag while reading sample. flags={stream_flags}"
                ));
            }
            if has_source_reader_flag(stream_flags, MF_SOURCE_READERF_ENDOFSTREAM.0) {
                return Err(format!(
                    "SourceReader reached end of stream before sample. attempts={attempt}"
                ));
            }

            if let Some(sample) = sample {
                let total_length = unsafe { sample.GetTotalLength().ok() };
                let buffer_count = unsafe { sample.GetBufferCount().ok() };
                let sample_time_hns = unsafe { sample.GetSampleTime().ok() };
                let sample_duration_hns = unsafe { sample.GetSampleDuration().ok() };
                return Ok(json!({
                    "status": "sample-read",
                    "backend": "media-foundation",
                    "device": video_device_record_to_json(record),
                    "mediaType": media_type_json,
                    "attempts": attempt,
                    "elapsedMs": started_at.elapsed().as_millis(),
                    "actualStreamIndex": actual_stream_index,
                    "streamFlags": stream_flags,
                    "streamFlagNames": source_reader_flag_names(stream_flags),
                    "timestampHns": timestamp_hns,
                    "sample": {
                        "totalLengthBytes": total_length,
                        "bufferCount": buffer_count,
                        "sampleTimeHns": sample_time_hns,
                        "sampleDurationHns": sample_duration_hns
                    },
                    "decodeStatus": "not-decoded"
                }));
            }
        }

        Err(format!(
            "No video sample returned after {max_attempts} attempts. lastFlags={last_flags}"
        ))
    })();
    shutdown_media_source(&source, &record.activate);
    result
}

fn measure_video_frames_for_record(
    record: &VideoDeviceActivate,
    media_type_index: u32,
    duration_ms: u32,
    max_reads: u32,
) -> Result<Value, String> {
    let source: IMFMediaSource = unsafe {
        record
            .activate
            .ActivateObject()
            .map_err(format_windows_error)?
    };
    let result = (|| {
        let reader = unsafe {
            MFCreateSourceReaderFromMediaSource(&source, None::<&IMFAttributes>)
                .map_err(format_windows_error)?
        };
        let media_type = unsafe {
            reader
                .GetNativeMediaType(video_stream_index(), media_type_index)
                .map_err(format_windows_error)?
        };
        unsafe {
            reader
                .SetCurrentMediaType(video_stream_index(), None, &media_type)
                .map_err(format_windows_error)?;
        }

        let media_type_json = media_type_to_json(&media_type, media_type_index);
        let started_at = Instant::now();
        let duration = Duration::from_millis(u64::from(duration_ms));
        let mut read_count = 0u32;
        let mut sample_count = 0u64;
        let mut empty_read_count = 0u64;
        let mut total_length_bytes = 0u64;
        let mut total_buffer_count = 0u64;
        let mut media_type_changed_count = 0u64;
        let mut native_media_type_changed_count = 0u64;
        let mut stream_flag_or = 0u32;
        let mut first_timestamp_hns = None;
        let mut last_timestamp_hns = None;
        let mut first_sample_time_hns = None;
        let mut last_sample_time_hns = None;
        let mut sample_duration_sum_hns = 0i128;
        let mut sample_duration_count = 0u64;

        while started_at.elapsed() < duration && read_count < max_reads {
            read_count = read_count.saturating_add(1);
            let mut actual_stream_index = 0u32;
            let mut stream_flags = 0u32;
            let mut timestamp_hns = 0i64;
            let mut sample = None;
            unsafe {
                reader
                    .ReadSample(
                        video_stream_index(),
                        0,
                        Some(&mut actual_stream_index),
                        Some(&mut stream_flags),
                        Some(&mut timestamp_hns),
                        Some(&mut sample),
                    )
                    .map_err(format_windows_error)?;
            }
            stream_flag_or |= stream_flags;

            if has_source_reader_flag(stream_flags, MF_SOURCE_READERF_ERROR.0) {
                return Err(format!(
                    "SourceReader reported error flag while measuring frames. flags={stream_flags}"
                ));
            }
            if has_source_reader_flag(stream_flags, MF_SOURCE_READERF_ENDOFSTREAM.0) {
                return Err(format!(
                    "SourceReader reached end of stream while measuring frames. reads={read_count}"
                ));
            }
            if has_source_reader_flag(stream_flags, MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0) {
                media_type_changed_count = media_type_changed_count.saturating_add(1);
            }
            if has_source_reader_flag(stream_flags, MF_SOURCE_READERF_NATIVEMEDIATYPECHANGED.0) {
                native_media_type_changed_count = native_media_type_changed_count.saturating_add(1);
            }

            if let Some(sample) = sample {
                sample_count = sample_count.saturating_add(1);
                first_timestamp_hns.get_or_insert(timestamp_hns);
                last_timestamp_hns = Some(timestamp_hns);
                if let Ok(total_length) = unsafe { sample.GetTotalLength() } {
                    total_length_bytes = total_length_bytes.saturating_add(u64::from(total_length));
                }
                if let Ok(buffer_count) = unsafe { sample.GetBufferCount() } {
                    total_buffer_count = total_buffer_count.saturating_add(u64::from(buffer_count));
                }
                if let Ok(sample_time_hns) = unsafe { sample.GetSampleTime() } {
                    first_sample_time_hns.get_or_insert(sample_time_hns);
                    last_sample_time_hns = Some(sample_time_hns);
                }
                if let Ok(sample_duration_hns) = unsafe { sample.GetSampleDuration() } {
                    sample_duration_sum_hns += i128::from(sample_duration_hns);
                    sample_duration_count = sample_duration_count.saturating_add(1);
                }
            } else {
                empty_read_count = empty_read_count.saturating_add(1);
                thread::sleep(Duration::from_millis(1));
            }
        }

        let elapsed_ms = started_at.elapsed().as_millis();
        let elapsed_ms_f64 = elapsed_ms as f64;
        let measured_fps = if elapsed_ms > 0 {
            Some(sample_count as f64 * 1000.0 / elapsed_ms_f64)
        } else {
            None
        };
        let measured_bytes_per_second = if elapsed_ms > 0 {
            Some(total_length_bytes as f64 * 1000.0 / elapsed_ms_f64)
        } else {
            None
        };
        let average_sample_duration_hns = if sample_duration_count > 0 {
            Some((sample_duration_sum_hns / i128::from(sample_duration_count)) as i64)
        } else {
            None
        };
        let frame_rate_from_duration = average_sample_duration_hns
            .filter(|duration| *duration > 0)
            .map(|duration| 10_000_000.0 / duration as f64);
        let media_time_span_hns = first_sample_time_hns
            .zip(last_sample_time_hns)
            .and_then(|(first, last)| last.checked_sub(first));
        let media_timeline_fps = media_time_span_hns
            .filter(|span| *span > 0 && sample_count > 1)
            .map(|span| (sample_count - 1) as f64 * 10_000_000.0 / span as f64);
        let status = if sample_count > 0 {
            "frames-measured"
        } else {
            "no-samples"
        };

        Ok(json!({
            "status": status,
            "backend": "media-foundation",
            "device": video_device_record_to_json(record),
            "mediaType": media_type_json,
            "durationMs": duration_ms,
            "elapsedMs": elapsed_ms,
            "maxReads": max_reads,
            "readCount": read_count,
            "sampleCount": sample_count,
            "emptyReadCount": empty_read_count,
            "measuredFps": measured_fps,
            "mediaTimelineFps": media_timeline_fps,
            "measuredBytesPerSecond": measured_bytes_per_second,
            "totalLengthBytes": total_length_bytes,
            "totalBufferCount": total_buffer_count,
            "averageSampleDurationHns": average_sample_duration_hns,
            "frameRateFromSampleDuration": frame_rate_from_duration,
            "firstTimestampHns": first_timestamp_hns,
            "lastTimestampHns": last_timestamp_hns,
            "firstSampleTimeHns": first_sample_time_hns,
            "lastSampleTimeHns": last_sample_time_hns,
            "mediaTimeSpanHns": media_time_span_hns,
            "streamFlagsOr": stream_flag_or,
            "streamFlagNames": source_reader_flag_names(stream_flag_or),
            "mediaTypeChangedCount": media_type_changed_count,
            "nativeMediaTypeChangedCount": native_media_type_changed_count,
            "decodeStatus": "not-decoded",
            "transportStatus": "not-published"
        }))
    })();
    shutdown_media_source(&source, &record.activate);
    result
}

fn select_video_records<'a>(
    records: &'a [VideoDeviceActivate],
    params: &Value,
) -> Result<Vec<&'a VideoDeviceActivate>, String> {
    if records.is_empty() {
        return Err("No Media Foundation video devices were found".to_string());
    }
    if params.get("all").and_then(Value::as_bool).unwrap_or(false) {
        return Ok(records.iter().collect());
    }
    if let Some(device_id) = params.get("deviceId").and_then(Value::as_str) {
        return records
            .iter()
            .find(|record| record.device_id == device_id)
            .map(|record| vec![record])
            .ok_or_else(|| format!("Video deviceId not found: {device_id}"));
    }
    if let Some(native_id) = params.get("nativeId").and_then(Value::as_str) {
        return records
            .iter()
            .find(|record| record.native_id == native_id)
            .map(|record| vec![record])
            .ok_or_else(|| format!("Video nativeId not found: {native_id}"));
    }
    let index = optional_u32(params, "index")?.unwrap_or(0);
    records
        .iter()
        .find(|record| record.index == index)
        .map(|record| vec![record])
        .ok_or_else(|| format!("Video index not found: {index}"))
}

fn media_type_to_json(media_type: &IMFMediaType, media_type_index: u32) -> Value {
    let major_type = unsafe { media_type.GetGUID(&MF_MT_MAJOR_TYPE).ok() };
    let subtype = unsafe { media_type.GetGUID(&MF_MT_SUBTYPE).ok() };
    let frame_size = unsafe { media_type.GetUINT64(&MF_MT_FRAME_SIZE).ok() };
    let frame_rate = unsafe { media_type.GetUINT64(&MF_MT_FRAME_RATE).ok() };
    let (width, height) = frame_size.map(unpack_ratio_u64).unwrap_or((0, 0));
    let (frame_rate_numerator, frame_rate_denominator) =
        frame_rate.map(unpack_ratio_u64).unwrap_or((0, 0));
    let frame_rate_value = if frame_rate_denominator > 0 {
        Some(frame_rate_numerator as f64 / frame_rate_denominator as f64)
    } else {
        None
    };

    json!({
        "mediaTypeIndex": media_type_index,
        "majorType": major_type.map(|guid| guid_label(&guid)),
        "subtype": subtype.map(|guid| guid_label(&guid)),
        "subtypeFourCc": subtype.and_then(|guid| guid_fourcc(&guid)),
        "width": width,
        "height": height,
        "frameRateNumerator": frame_rate_numerator,
        "frameRateDenominator": frame_rate_denominator,
        "frameRate": frame_rate_value
    })
}

fn unpack_ratio_u64(value: u64) -> (u32, u32) {
    ((value >> 32) as u32, value as u32)
}

fn guid_label(guid: &GUID) -> String {
    if *guid == MFMediaType_Video {
        "video".to_string()
    } else if *guid == MFVideoFormat_MJPG {
        "MJPG".to_string()
    } else if *guid == MFVideoFormat_YUY2 {
        "YUY2".to_string()
    } else if *guid == MFVideoFormat_NV12 {
        "NV12".to_string()
    } else if *guid == MFVideoFormat_RGB24 {
        "RGB24".to_string()
    } else if *guid == MFVideoFormat_RGB32 {
        "RGB32".to_string()
    } else if *guid == MFVideoFormat_I420 {
        "I420".to_string()
    } else if *guid == MFVideoFormat_H264 {
        "H264".to_string()
    } else if *guid == MFVideoFormat_HEVC {
        "HEVC".to_string()
    } else if *guid == MFVideoFormat_UYVY {
        "UYVY".to_string()
    } else if *guid == MFVideoFormat_YV12 {
        "YV12".to_string()
    } else {
        format!("{guid:?}")
    }
}

fn guid_fourcc(guid: &GUID) -> Option<String> {
    let base_tail = [0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
    if guid.data2 != 0 || guid.data3 != 0x0010 || guid.data4 != base_tail {
        return None;
    }
    let bytes = guid.data1.to_le_bytes();
    if bytes
        .iter()
        .all(|byte| byte.is_ascii_graphic() || *byte == b' ')
    {
        Some(String::from_utf8_lossy(&bytes).trim().to_string())
    } else {
        None
    }
}

fn optional_u32(params: &Value, field_name: &str) -> Result<Option<u32>, String> {
    let Some(value) = params.get(field_name) else {
        return Ok(None);
    };
    let Some(number) = value.as_u64() else {
        return Err(format!("{field_name} must be a non-negative integer"));
    };
    u32::try_from(number)
        .map(Some)
        .map_err(|_| format!("{field_name} is too large for u32"))
}

fn video_stream_index() -> u32 {
    MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32
}

fn has_source_reader_flag(flags: u32, flag: i32) -> bool {
    flags & flag as u32 != 0
}

fn source_reader_flag_names(flags: u32) -> Vec<&'static str> {
    let mut names = Vec::new();
    if has_source_reader_flag(flags, MF_SOURCE_READERF_ERROR.0) {
        names.push("error");
    }
    if has_source_reader_flag(flags, MF_SOURCE_READERF_ENDOFSTREAM.0) {
        names.push("end-of-stream");
    }
    if has_source_reader_flag(flags, MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0) {
        names.push("current-media-type-changed");
    }
    if has_source_reader_flag(flags, MF_SOURCE_READERF_NATIVEMEDIATYPECHANGED.0) {
        names.push("native-media-type-changed");
    }
    if has_source_reader_flag(flags, MF_SOURCE_READERF_NEWSTREAM.0) {
        names.push("new-stream");
    }
    if has_source_reader_flag(flags, MF_SOURCE_READERF_STREAMTICK.0) {
        names.push("stream-tick");
    }
    if has_source_reader_flag(flags, MF_SOURCE_READERF_ALLEFFECTSREMOVED.0) {
        names.push("all-effects-removed");
    }
    names
}

fn shutdown_media_source(source: &IMFMediaSource, activate: &IMFActivate) {
    let _ = unsafe { source.Shutdown() };
    let _ = unsafe { activate.ShutdownObject() };
}

fn enumerate_audio_capture_devices() -> Result<Vec<Value>, String> {
    with_audio_capture_devices(|records| {
        Ok(records
            .iter()
            .map(audio_device_record_to_json)
            .collect::<Vec<_>>())
    })
}

fn with_audio_capture_devices<T>(
    callback: impl FnOnce(Vec<AudioDeviceRecord>) -> Result<T, String>,
) -> Result<T, String> {
    let enumerator: IMMDeviceEnumerator = unsafe {
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(format_windows_error)?
    };
    let collection = unsafe {
        enumerator
            .EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)
            .map_err(format_windows_error)?
    };
    let count = unsafe { collection.GetCount().map_err(format_windows_error)? };
    let mut devices = Vec::new();

    for index in 0..count {
        let device = unsafe { collection.Item(index).map_err(format_windows_error)? };
        let id_ptr = unsafe { device.GetId().map_err(format_windows_error)? };
        let native_id =
            take_cotask_pwstr(id_ptr).unwrap_or_else(|| format!("wasapi-capture-{index}"));
        let display_name = unsafe {
            device
                .OpenPropertyStore(STGM_READ)
                .ok()
                .and_then(|store| store.GetValue(&PKEY_Device_FriendlyName).ok())
                .and_then(|value| BSTR::try_from(&value).ok())
                .map(|name| name.to_string())
        }
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| native_id.clone());

        let device_id = stable_device_id("wasapi-audio", index, &native_id);
        let transport = infer_transport(&native_id, &display_name);
        devices.push(AudioDeviceRecord {
            index,
            device_id,
            display_name,
            native_id,
            transport,
            device,
        });
    }

    callback(devices)
}

fn audio_device_record_to_json(record: &AudioDeviceRecord) -> Value {
    json!({
        "index": record.index,
        "deviceId": record.device_id,
        "displayName": record.display_name,
        "transport": record.transport,
        "role": "room-microphone",
        "backend": "wasapi",
        "nativeId": record.native_id,
        "dataFlow": "capture",
        "state": "active",
        "capabilities": [],
        "capabilitiesStatus": "not-enumerated",
        "capabilityProbeRequired": true
    })
}

fn probe_audio_format(params: &Value) -> Result<Value, String> {
    let _com = ComApartment::initialize()?;
    with_audio_capture_devices(|records| {
        let selected = select_audio_records(&records, params)?;
        let mut devices = Vec::new();
        for record in selected {
            devices.push(probe_audio_record_format(record)?);
        }
        Ok(json!({
            "status": "ok",
            "backend": "wasapi",
            "deviceCount": devices.len(),
            "devices": devices
        }))
    })
}

fn capture_audio_buffer(params: &Value) -> Result<Value, String> {
    let duration_ms = optional_u32(params, "durationMs")?
        .unwrap_or(500)
        .clamp(100, 5_000);
    let poll_interval_ms = optional_u32(params, "pollIntervalMs")?
        .unwrap_or(10)
        .clamp(1, 100);
    let _com = ComApartment::initialize()?;
    with_audio_capture_devices(|records| {
        let selected = select_audio_records(&records, params)?;
        let record = selected
            .first()
            .copied()
            .ok_or_else(|| "No audio capture device selected".to_string())?;
        capture_audio_buffer_for_record(record, duration_ms, poll_interval_ms)
    })
}

fn probe_audio_record_format(record: &AudioDeviceRecord) -> Result<Value, String> {
    let audio_client: IAudioClient = unsafe {
        record
            .device
            .Activate(CLSCTX_ALL, None)
            .map_err(format_windows_error)?
    };
    let mut default_period_hns = 0i64;
    let mut minimum_period_hns = 0i64;
    let _ = unsafe {
        audio_client.GetDevicePeriod(Some(&mut default_period_hns), Some(&mut minimum_period_hns))
    };
    with_audio_mix_format(&audio_client, |format_ptr| {
        Ok(json!({
            "device": audio_device_record_to_json(record),
            "capabilitiesStatus": "mix-format-enumerated",
            "mixFormat": wave_format_to_json(format_ptr)?,
            "devicePeriod": {
                "defaultHns": default_period_hns,
                "minimumHns": minimum_period_hns
            }
        }))
    })
}

fn capture_audio_buffer_for_record(
    record: &AudioDeviceRecord,
    duration_ms: u32,
    poll_interval_ms: u32,
) -> Result<Value, String> {
    let audio_client: IAudioClient = unsafe {
        record
            .device
            .Activate(CLSCTX_ALL, None)
            .map_err(format_windows_error)?
    };
    with_audio_mix_format(&audio_client, |format_ptr| {
        let mix_format = wave_format_to_json(format_ptr)?;
        let format = unsafe { *format_ptr };
        let block_align = u64::from(format.nBlockAlign.max(1));
        let stream_buffer_duration_hns = i64::from(duration_ms.max(500)) * 10_000;
        unsafe {
            audio_client
                .Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    0,
                    stream_buffer_duration_hns,
                    0,
                    format_ptr,
                    None,
                )
                .map_err(format_windows_error)?;
        }
        let buffer_frame_capacity = unsafe { audio_client.GetBufferSize().ok() };
        let stream_latency_hns = unsafe { audio_client.GetStreamLatency().ok() };
        let capture_client: IAudioCaptureClient =
            unsafe { audio_client.GetService().map_err(format_windows_error)? };
        unsafe {
            audio_client.Start().map_err(format_windows_error)?;
        }

        let started_at = Instant::now();
        let capture_result = (|| {
            let mut poll_count = 0u32;
            let mut packet_count = 0u64;
            let mut captured_frames = 0u64;
            let mut captured_bytes = 0u64;
            let mut silent_packets = 0u64;
            let mut discontinuity_packets = 0u64;
            let mut timestamp_error_packets = 0u64;
            let mut last_device_position = None;
            let mut last_qpc_position = None;

            while started_at.elapsed() < Duration::from_millis(u64::from(duration_ms)) {
                poll_count = poll_count.saturating_add(1);
                let mut packet_size = unsafe {
                    capture_client
                        .GetNextPacketSize()
                        .map_err(format_windows_error)?
                };
                while packet_size > 0 {
                    let mut data_ptr: *mut u8 = ptr::null_mut();
                    let mut frames_to_read = 0u32;
                    let mut flags = 0u32;
                    let mut device_position = 0u64;
                    let mut qpc_position = 0u64;
                    unsafe {
                        capture_client
                            .GetBuffer(
                                &mut data_ptr,
                                &mut frames_to_read,
                                &mut flags,
                                Some(&mut device_position),
                                Some(&mut qpc_position),
                            )
                            .map_err(format_windows_error)?;
                    }

                    packet_count = packet_count.saturating_add(1);
                    let frame_count = u64::from(frames_to_read);
                    captured_frames = captured_frames.saturating_add(frame_count);
                    captured_bytes =
                        captured_bytes.saturating_add(frame_count.saturating_mul(block_align));
                    if has_audio_buffer_flag(flags, AUDCLNT_BUFFERFLAGS_SILENT.0) {
                        silent_packets = silent_packets.saturating_add(1);
                    }
                    if has_audio_buffer_flag(flags, AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0) {
                        discontinuity_packets = discontinuity_packets.saturating_add(1);
                    }
                    if has_audio_buffer_flag(flags, AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0) {
                        timestamp_error_packets = timestamp_error_packets.saturating_add(1);
                    }
                    last_device_position = Some(device_position);
                    last_qpc_position = Some(qpc_position);

                    unsafe {
                        capture_client
                            .ReleaseBuffer(frames_to_read)
                            .map_err(format_windows_error)?;
                    }
                    packet_size = unsafe {
                        capture_client
                            .GetNextPacketSize()
                            .map_err(format_windows_error)?
                    };
                }
                thread::sleep(Duration::from_millis(u64::from(poll_interval_ms)));
            }

            let status = if packet_count > 0 {
                "buffer-captured"
            } else {
                "no-packets"
            };
            Ok(json!({
                "status": status,
                "backend": "wasapi",
                "device": audio_device_record_to_json(record),
                "mixFormat": mix_format,
                "durationMs": duration_ms,
                "elapsedMs": started_at.elapsed().as_millis(),
                "pollIntervalMs": poll_interval_ms,
                "pollCount": poll_count,
                "packetCount": packet_count,
                "capturedFrames": captured_frames,
                "capturedBytes": captured_bytes,
                "silentPackets": silent_packets,
                "discontinuityPackets": discontinuity_packets,
                "timestampErrorPackets": timestamp_error_packets,
                "bufferFrameCapacity": buffer_frame_capacity,
                "streamLatencyHns": stream_latency_hns,
                "lastDevicePosition": last_device_position,
                "lastQpcPosition": last_qpc_position,
                "decodeStatus": "not-decoded"
            }))
        })();
        let stop_result = unsafe { audio_client.Stop().map_err(format_windows_error) };
        match (capture_result, stop_result) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
        }
    })
}

fn with_audio_mix_format<T>(
    audio_client: &IAudioClient,
    callback: impl FnOnce(*mut WAVEFORMATEX) -> Result<T, String>,
) -> Result<T, String> {
    let format_ptr = unsafe { audio_client.GetMixFormat().map_err(format_windows_error)? };
    if format_ptr.is_null() {
        return Err("IAudioClient::GetMixFormat returned null".to_string());
    }
    let result = callback(format_ptr);
    unsafe {
        CoTaskMemFree(Some(format_ptr.cast()));
    }
    result
}

fn select_audio_records<'a>(
    records: &'a [AudioDeviceRecord],
    params: &Value,
) -> Result<Vec<&'a AudioDeviceRecord>, String> {
    if records.is_empty() {
        return Err("No WASAPI audio capture devices were found".to_string());
    }
    if params.get("all").and_then(Value::as_bool).unwrap_or(false) {
        return Ok(records.iter().collect());
    }
    if let Some(device_id) = params.get("deviceId").and_then(Value::as_str) {
        return records
            .iter()
            .find(|record| record.device_id == device_id)
            .map(|record| vec![record])
            .ok_or_else(|| format!("Audio deviceId not found: {device_id}"));
    }
    if let Some(native_id) = params.get("nativeId").and_then(Value::as_str) {
        return records
            .iter()
            .find(|record| record.native_id == native_id)
            .map(|record| vec![record])
            .ok_or_else(|| format!("Audio nativeId not found: {native_id}"));
    }
    let index = optional_u32(params, "index")?.unwrap_or(0);
    records
        .iter()
        .find(|record| record.index == index)
        .map(|record| vec![record])
        .ok_or_else(|| format!("Audio index not found: {index}"))
}

fn wave_format_to_json(format_ptr: *const WAVEFORMATEX) -> Result<Value, String> {
    if format_ptr.is_null() {
        return Err("WAVEFORMATEX pointer is null".to_string());
    }
    let format = unsafe { *format_ptr };
    let format_tag = format.wFormatTag;
    let channels = format.nChannels;
    let samples_per_sec = format.nSamplesPerSec;
    let avg_bytes_per_sec = format.nAvgBytesPerSec;
    let block_align = format.nBlockAlign;
    let bits_per_sample = format.wBitsPerSample;
    let cb_size = format.cbSize;
    let mut payload = json!({
        "formatTag": format_tag,
        "formatTagName": wave_format_tag_name(format_tag),
        "channels": channels,
        "samplesPerSec": samples_per_sec,
        "avgBytesPerSec": avg_bytes_per_sec,
        "blockAlign": block_align,
        "bitsPerSample": bits_per_sample,
        "cbSize": cb_size,
        "bytesPerFrame": block_align
    });

    let extensible_extra_size =
        std::mem::size_of::<WAVEFORMATEXTENSIBLE>() - std::mem::size_of::<WAVEFORMATEX>();
    if format_tag == WAVE_FORMAT_EXTENSIBLE_TAG && usize::from(cb_size) >= extensible_extra_size {
        let extensible = unsafe { *(format_ptr.cast::<WAVEFORMATEXTENSIBLE>()) };
        let valid_bits_per_sample = unsafe { extensible.Samples.wValidBitsPerSample };
        let channel_mask = extensible.dwChannelMask;
        let sub_format = extensible.SubFormat;
        payload["validBitsPerSample"] = json!(valid_bits_per_sample);
        payload["channelMask"] = json!(channel_mask);
        payload["channelMaskHex"] = json!(format!("0x{channel_mask:08x}"));
        payload["subFormat"] = json!(format!("{sub_format:?}"));
        payload["subFormatName"] = json!(wave_subformat_label(&sub_format));
    }

    Ok(payload)
}

fn wave_format_tag_name(format_tag: u16) -> &'static str {
    match format_tag {
        WAVE_FORMAT_PCM_TAG => "PCM",
        WAVE_FORMAT_IEEE_FLOAT_TAG => "IEEE_FLOAT",
        WAVE_FORMAT_EXTENSIBLE_TAG => "EXTENSIBLE",
        _ => "UNKNOWN",
    }
}

fn wave_subformat_label(guid: &GUID) -> String {
    let wave_format_tail = [0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
    if guid.data2 == 0 && guid.data3 == 0x0010 && guid.data4 == wave_format_tail {
        match guid.data1 as u16 {
            WAVE_FORMAT_PCM_TAG => "PCM".to_string(),
            WAVE_FORMAT_IEEE_FLOAT_TAG => "IEEE_FLOAT".to_string(),
            other => format!("WAVE_FORMAT_{other}"),
        }
    } else {
        format!("{guid:?}")
    }
}

fn has_audio_buffer_flag(flags: u32, flag: i32) -> bool {
    flags & flag as u32 != 0
}

fn get_mf_allocated_string(activate: &IMFActivate, key: &windows::core::GUID) -> Option<String> {
    let mut value = PWSTR::null();
    let mut len = 0u32;
    unsafe {
        activate
            .GetAllocatedString(key, &mut value, &mut len)
            .ok()?;
    }
    let result = take_cotask_pwstr(value)?;
    if result.trim().is_empty() {
        None
    } else {
        Some(result)
    }
}

fn take_cotask_pwstr(value: PWSTR) -> Option<String> {
    if value.is_null() {
        return None;
    }
    let result = unsafe { value.to_string().ok() };
    unsafe {
        CoTaskMemFree(Some(value.as_ptr().cast()));
    }
    result
}

fn stable_device_id(prefix: &str, index: u32, native_id: &str) -> String {
    let hash = fnv1a32(native_id.as_bytes());
    format!("{prefix}-{index}-{hash:08x}")
}

fn fnv1a32(bytes: &[u8]) -> u32 {
    let mut hash = 0x811c9dc5u32;
    for byte in bytes {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

fn infer_transport(native_id: &str, display_name: &str) -> &'static str {
    let haystack = format!("{native_id} {display_name}").to_ascii_lowercase();
    if haystack.contains("usb") || haystack.contains("vid_") {
        "usb"
    } else {
        "system"
    }
}

fn format_windows_error(error: windows::core::Error) -> String {
    format!("{error}")
}

struct ComApartment;

impl ComApartment {
    fn initialize() -> Result<Self, String> {
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if hr.is_err() {
            return Err(format!("CoInitializeEx failed: {hr:?}"));
        }
        Ok(Self)
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}

struct MediaFoundationSession;

impl MediaFoundationSession {
    fn start() -> Result<Self, String> {
        unsafe {
            MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(format_windows_error)?;
        }
        Ok(Self)
    }
}

impl Drop for MediaFoundationSession {
    fn drop(&mut self) {
        let _ = unsafe { MFShutdown() };
    }
}

fn idle_recording() -> Value {
    json!({
        "state": "idle",
        "activeChannelIds": []
    })
}

fn idle_capture_session() -> Value {
    json!({
        "state": "idle",
        "mode": Value::Null,
        "realMediaSession": false,
        "startedAt": Value::Null,
        "mediaPayloadTransport": "native-only",
        "continuousVideoThreads": "not-started",
        "continuousVideoThreadCount": 0,
        "continuousAudioThreads": "not-started",
        "previewStatus": "not-rendered",
        "livekitStatus": "idle",
        "recordingStatus": "idle"
    })
}

fn idle_stats() -> Value {
    json!({
        "uptimeMs": 0,
        "framesProduced": 0,
        "videoBytesCaptured": 0,
        "videoCaptureThreadCount": 0,
        "videoCaptureThreads": [],
        "videoFrameQueuePushCount": 0,
        "videoFrameQueueDropCount": 0,
        "audioPacketsProduced": 0,
        "audioFramesCaptured": 0,
        "audioBytesCaptured": 0,
        "syntheticFramesProduced": 0,
        "boundVideoChannels": 0,
        "unassignedVideoChannels": 0,
        "boundAudioEndpoints": 0,
        "realMediaSession": false
    })
}

fn idle_livekit() -> Value {
    json!({
        "state": "idle",
        "roomName": Value::Null,
        "livekitUrl": Value::Null,
        "publisherKind": Value::Null,
        "realPublisher": false,
        "requiresNativeSdk": true,
        "startedAt": Value::Null,
        "publishedTrackNames": []
    })
}

fn required_string(value: Option<&Value>, field_name: &'static str) -> Result<String, WorkerError> {
    let Some(value) = value else {
        return Err(WorkerError::new(
            "missing-field",
            format!("{field_name} is required"),
        ));
    };
    let Some(text) = value.as_str() else {
        return Err(WorkerError::new(
            "missing-field",
            format!("{field_name} is required"),
        ));
    };
    if text.trim().is_empty() {
        return Err(WorkerError::new(
            "missing-field",
            format!("{field_name} is required"),
        ));
    }
    Ok(text.trim().to_string())
}

fn send_response(id: Value, ok: bool, key: &str, payload: Value) {
    write_json(json!({
        "type": "response",
        "id": id,
        "ok": ok,
        key: payload
    }));
}

fn emit_event(category: &str, name: &str, payload: Value) {
    write_json(json!({
        "type": "event",
        "event": {
            "category": category,
            "name": name,
            "payload": payload,
            "time": now_iso_like()
        }
    }));
}

fn write_json(payload: Value) {
    println!("{payload}");
    let _ = io::stdout().flush();
}

fn now_iso_like() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("unix-ms-{millis}")
}

#[derive(Debug)]
struct WorkerError {
    code: &'static str,
    message: String,
}

impl WorkerError {
    fn new(code: &'static str, message: String) -> Self {
        Self { code, message }
    }
}
