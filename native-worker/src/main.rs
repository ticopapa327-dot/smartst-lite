use serde_json::{json, Value};
use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
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
    eCapture, eRender, IAudioCaptureClient, IAudioClient, IAudioRenderClient, IMMDevice,
    IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR, AUDCLNT_SHAREMODE_SHARED,
    DEVICE_STATE_ACTIVE, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
use windows::Win32::Media::MediaFoundation::{
    IMFActivate, IMFAttributes, IMFMediaSource, IMFMediaType, IMFSample, MFCreateAttributes,
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
    payload_queue: Arc<Mutex<AudioPayloadQueue>>,
    handle: Option<JoinHandle<()>>,
}

struct VideoCaptureRuntime {
    channel_id: String,
    stop: Arc<AtomicBool>,
    stats: Arc<Mutex<VideoCaptureThreadStats>>,
    payload_queue: Arc<Mutex<VideoPayloadQueue>>,
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
    audio_level_status: String,
    audio_level_format: String,
    audio_level_sample_count: u64,
    audio_level_frame_count: u64,
    audio_level_sum_squares: f64,
    audio_level_peak: f64,
    audio_level_last_rms: Option<f64>,
    audio_level_last_peak: Option<f64>,
    audio_level_last_packet_frames: Option<u32>,
    audio_level_unsupported_packets: u64,
    payload_queue_capacity: u32,
    payload_queue_depth: u32,
    payload_queue_bytes: u64,
    payload_queue_copy_count: u64,
    payload_queue_copy_error_count: u64,
    payload_queue_drop_count: u64,
    payload_queue_consume_count: u64,
    payload_queue_total_copied_bytes: u64,
    payload_queue_consumed_bytes: u64,
    payload_queue_dropped_bytes: u64,
    payload_queue_latest_bytes: Option<u32>,
    payload_queue_latest_sequence: Option<u64>,
    payload_queue_latest_consumed_sequence: Option<u64>,
    payload_queue_consumer_status: String,
    poll_count: u64,
    last_device_position: Option<u64>,
    last_qpc_position: Option<u64>,
    buffer_frame_capacity: Option<u32>,
    stream_latency_hns: Option<i64>,
    device: Value,
    mix_format: Value,
    last_error: Option<String>,
}

struct AudioPayloadQueue {
    packets: VecDeque<AudioPayloadPacket>,
    bytes: u64,
}

struct AudioPayloadPacket {
    sequence: u64,
    device_position: Option<u64>,
    qpc_position: Option<u64>,
    frames: u32,
    payload: Vec<u8>,
}

struct AudioPayloadQueuePush {
    depth: u32,
    bytes: u64,
    payload_bytes: u32,
    dropped_packet: bool,
    dropped_bytes: u64,
}

struct AudioPayloadQueueConsume {
    consumed_packets: u32,
    consumed_bytes: u64,
    latest_sequence: Option<u64>,
    latest_device_position: Option<u64>,
    latest_qpc_position: Option<u64>,
    latest_frames: Option<u32>,
    remaining_depth: u32,
    remaining_bytes: u64,
}

struct AudioPayloadQueueDrain {
    packets: Vec<AudioPayloadPacket>,
    consumed_bytes: u64,
    remaining_depth: u32,
    remaining_bytes: u64,
}

struct AudioWavFormat {
    format_tag: u16,
    channels: u16,
    samples_per_sec: u32,
    avg_bytes_per_sec: u32,
    block_align: u16,
    bits_per_sample: u16,
    source_format: Value,
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
    frame_payload_queue_depth: u32,
    frame_payload_queue_bytes: u64,
    frame_payload_copy_count: u64,
    frame_payload_copy_error_count: u64,
    frame_payload_total_copied_bytes: u64,
    frame_payload_dropped_bytes: u64,
    frame_payload_latest_bytes: Option<u32>,
    frame_payload_consume_count: u64,
    frame_payload_consumed_bytes: u64,
    frame_payload_latest_consumed_sequence: Option<u64>,
    frame_payload_consumer_status: String,
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

struct VideoPayloadQueue {
    frames: VecDeque<VideoPayloadFrame>,
    bytes: u64,
}

struct VideoPayloadFrame {
    sequence: u64,
    timestamp_hns: i64,
    sample_time_hns: Option<i64>,
    total_length_bytes: Option<u32>,
    payload: Vec<u8>,
}

struct VideoPayloadQueuePush {
    depth: u32,
    bytes: u64,
    payload_bytes: u32,
    dropped_frame: bool,
    dropped_bytes: u64,
}

struct VideoPayloadQueueConsume {
    consumed_frames: u32,
    consumed_bytes: u64,
    latest_sequence: Option<u64>,
    latest_timestamp_hns: Option<i64>,
    latest_sample_time_hns: Option<i64>,
    latest_total_length_bytes: Option<u32>,
    remaining_depth: u32,
    remaining_bytes: u64,
}

struct VideoPayloadQueueDrain {
    frames: Vec<VideoPayloadFrame>,
    consumed_bytes: u64,
    remaining_depth: u32,
    remaining_bytes: u64,
}

struct VideoNv12FrameFormat {
    width: u32,
    height: u32,
    subtype_fourcc: String,
    source_format: Value,
}

#[derive(Clone)]
struct VideoFormatPreference {
    subtype_fourcc: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    frame_rate: Option<f64>,
    min_width: Option<u32>,
    min_height: Option<u32>,
    min_frame_rate: Option<f64>,
    max_media_types: u32,
}

struct VideoMediaTypeSelection {
    media_type: Value,
    selection: Value,
}

struct AudioLevelPacketMeasurement {
    status: &'static str,
    format: &'static str,
    frame_count: u64,
    sample_count: u64,
    sum_squares: f64,
    peak: f64,
}

impl VideoPayloadQueue {
    fn new() -> Self {
        Self {
            frames: VecDeque::new(),
            bytes: 0,
        }
    }

    fn push(&mut self, frame: VideoPayloadFrame, capacity: u32) -> VideoPayloadQueuePush {
        let capacity = capacity.max(1) as usize;
        let mut dropped_frame = false;
        let mut dropped_bytes = 0u64;
        while self.frames.len() >= capacity {
            if let Some(dropped) = self.frames.pop_front() {
                dropped_frame = true;
                dropped_bytes = dropped_bytes.saturating_add(dropped.payload.len() as u64);
                self.bytes = self.bytes.saturating_sub(dropped.payload.len() as u64);
            } else {
                break;
            }
        }

        let payload_bytes = u32::try_from(frame.payload.len()).unwrap_or(u32::MAX);
        self.bytes = self.bytes.saturating_add(frame.payload.len() as u64);
        self.frames.push_back(frame);

        VideoPayloadQueuePush {
            depth: self.frames.len() as u32,
            bytes: self.bytes,
            payload_bytes,
            dropped_frame,
            dropped_bytes,
        }
    }

    fn drain(&mut self, max_frames: u32) -> VideoPayloadQueueDrain {
        let max_frames = max_frames.max(1);
        let mut frames = Vec::new();
        let mut consumed_bytes = 0u64;

        while (frames.len() as u32) < max_frames {
            let Some(frame) = self.frames.pop_front() else {
                break;
            };
            consumed_bytes = consumed_bytes.saturating_add(frame.payload.len() as u64);
            self.bytes = self.bytes.saturating_sub(frame.payload.len() as u64);
            frames.push(frame);
        }

        VideoPayloadQueueDrain {
            frames,
            consumed_bytes,
            remaining_depth: self.frames.len() as u32,
            remaining_bytes: self.bytes,
        }
    }

    fn consume(&mut self, max_frames: u32) -> VideoPayloadQueueConsume {
        let drain = self.drain(max_frames);
        let mut latest_sequence = None;
        let mut latest_timestamp_hns = None;
        let mut latest_sample_time_hns = None;
        let mut latest_total_length_bytes = None;

        for frame in &drain.frames {
            latest_sequence = Some(frame.sequence);
            latest_timestamp_hns = Some(frame.timestamp_hns);
            latest_sample_time_hns = frame.sample_time_hns;
            latest_total_length_bytes = frame.total_length_bytes;
        }

        VideoPayloadQueueConsume {
            consumed_frames: drain.frames.len() as u32,
            consumed_bytes: drain.consumed_bytes,
            latest_sequence,
            latest_timestamp_hns,
            latest_sample_time_hns,
            latest_total_length_bytes,
            remaining_depth: drain.remaining_depth,
            remaining_bytes: drain.remaining_bytes,
        }
    }
}

impl AudioPayloadQueue {
    fn new() -> Self {
        Self {
            packets: VecDeque::new(),
            bytes: 0,
        }
    }

    fn push(&mut self, packet: AudioPayloadPacket, capacity: u32) -> AudioPayloadQueuePush {
        let capacity = capacity.max(1) as usize;
        let mut dropped_packet = false;
        let mut dropped_bytes = 0u64;
        while self.packets.len() >= capacity {
            if let Some(dropped) = self.packets.pop_front() {
                dropped_packet = true;
                dropped_bytes = dropped_bytes.saturating_add(dropped.payload.len() as u64);
                self.bytes = self.bytes.saturating_sub(dropped.payload.len() as u64);
            } else {
                break;
            }
        }

        let _packet_metadata = (
            packet.sequence,
            packet.device_position,
            packet.qpc_position,
            packet.frames,
        );
        let payload_bytes = u32::try_from(packet.payload.len()).unwrap_or(u32::MAX);
        self.bytes = self.bytes.saturating_add(packet.payload.len() as u64);
        self.packets.push_back(packet);

        AudioPayloadQueuePush {
            depth: self.packets.len() as u32,
            bytes: self.bytes,
            payload_bytes,
            dropped_packet,
            dropped_bytes,
        }
    }

    fn drain(&mut self, max_packets: u32) -> AudioPayloadQueueDrain {
        let max_packets = max_packets.max(1);
        let mut packets = Vec::new();
        let mut consumed_bytes = 0u64;

        while (packets.len() as u32) < max_packets {
            let Some(packet) = self.packets.pop_front() else {
                break;
            };
            consumed_bytes = consumed_bytes.saturating_add(packet.payload.len() as u64);
            self.bytes = self.bytes.saturating_sub(packet.payload.len() as u64);
            packets.push(packet);
        }

        AudioPayloadQueueDrain {
            packets,
            consumed_bytes,
            remaining_depth: self.packets.len() as u32,
            remaining_bytes: self.bytes,
        }
    }

    fn consume(&mut self, max_packets: u32) -> AudioPayloadQueueConsume {
        let drain = self.drain(max_packets);
        let mut latest_sequence = None;
        let mut latest_device_position = None;
        let mut latest_qpc_position = None;
        let mut latest_frames = None;

        for packet in &drain.packets {
            latest_sequence = Some(packet.sequence);
            latest_device_position = packet.device_position;
            latest_qpc_position = packet.qpc_position;
            latest_frames = Some(packet.frames);
        }

        AudioPayloadQueueConsume {
            consumed_packets: drain.packets.len() as u32,
            consumed_bytes: drain.consumed_bytes,
            latest_sequence,
            latest_device_position,
            latest_qpc_position,
            latest_frames,
            remaining_depth: drain.remaining_depth,
            remaining_bytes: drain.remaining_bytes,
        }
    }
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
        "probeAudioRenderFormat" => Ok((
            probe_audio_render_format(&params)
                .map_err(|message| WorkerError::new("native-media-error", message))?,
            false,
        )),
        "captureAudioBuffer" => Ok((
            capture_audio_buffer(&params)
                .map_err(|message| WorkerError::new("native-media-error", message))?,
            false,
        )),
        "renderAudioSilence" => Ok((
            render_audio_silence(&params)
                .map_err(|message| WorkerError::new("native-media-error", message))?,
            false,
        )),
        "start" => Ok((start_worker(state, &params), false)),
        "stop" => Ok((stop_worker(state), false)),
        "consumeVideoPayloadQueue" => Ok((consume_video_payload_queue(state, &params)?, false)),
        "consumeAudioPayloadQueue" => Ok((consume_audio_payload_queue(state, &params)?, false)),
        "exportVideoPayloadQueuePgm" => {
            Ok((export_video_payload_queue_pgm(state, &params)?, false))
        }
        "exportVideoPayloadQueuePpm" => {
            Ok((export_video_payload_queue_ppm(state, &params)?, false))
        }
        "exportAudioPayloadQueueWav" => {
            Ok((export_audio_payload_queue_wav(state, &params)?, false))
        }
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
    for (channel_id, video_index, media_type_index) in
        video_thread_start_targets(&state.channels, &params)
    {
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
        let audio_payload_queue_capacity = optional_u32(&params, "audioPayloadQueueCapacity")
            .ok()
            .flatten()
            .unwrap_or(50)
            .clamp(1, 500);
        state.audio_runtime = Some(start_audio_capture_runtime(
            audio_index,
            poll_interval_ms,
            audio_payload_queue_capacity,
        ));
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

fn consume_video_payload_queue(
    state: &mut WorkerState,
    params: &Value,
) -> Result<Value, WorkerError> {
    let max_frames = optional_u32(params, "maxFrames")
        .map_err(|message| WorkerError::new("invalid-params", message))?
        .unwrap_or(1)
        .clamp(1, 120);
    let requested_channel_id = params.get("channelId").and_then(Value::as_str);
    let runtime = if let Some(channel_id) = requested_channel_id {
        state
            .video_runtimes
            .iter()
            .find(|runtime| runtime.channel_id == channel_id)
    } else {
        state.video_runtimes.first()
    };
    let Some(runtime) = runtime else {
        return Err(WorkerError::new(
            "native-media-error",
            "No running video payload queue is available".to_string(),
        ));
    };

    let result = runtime
        .consume_payload_queue(max_frames)
        .map_err(|message| WorkerError::new("native-media-error", message))?;
    emit_event("video", "payload-queue-consumed", result.clone());
    Ok(result)
}

fn export_video_payload_queue_pgm(
    state: &mut WorkerState,
    params: &Value,
) -> Result<Value, WorkerError> {
    let max_frames = optional_u32(params, "maxFrames")
        .map_err(|message| WorkerError::new("invalid-params", message))?
        .unwrap_or(1)
        .clamp(1, 10);
    let overwrite = params
        .get("overwrite")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let Some(path) = params.get("path").and_then(Value::as_str) else {
        return Err(WorkerError::new(
            "invalid-params",
            "exportVideoPayloadQueuePgm requires a path".to_string(),
        ));
    };
    let requested_channel_id = params.get("channelId").and_then(Value::as_str);
    let runtime = if let Some(channel_id) = requested_channel_id {
        state
            .video_runtimes
            .iter()
            .find(|runtime| runtime.channel_id == channel_id)
    } else {
        state.video_runtimes.first()
    };
    let Some(runtime) = runtime else {
        return Err(WorkerError::new(
            "native-media-error",
            "No running video payload queue is available".to_string(),
        ));
    };

    let result = runtime
        .export_payload_queue_pgm(PathBuf::from(path), max_frames, overwrite)
        .map_err(|message| WorkerError::new("native-media-error", message))?;
    emit_event("video", "payload-queue-pgm-exported", result.clone());
    Ok(result)
}

fn export_video_payload_queue_ppm(
    state: &mut WorkerState,
    params: &Value,
) -> Result<Value, WorkerError> {
    let max_frames = optional_u32(params, "maxFrames")
        .map_err(|message| WorkerError::new("invalid-params", message))?
        .unwrap_or(1)
        .clamp(1, 10);
    let overwrite = params
        .get("overwrite")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let Some(path) = params.get("path").and_then(Value::as_str) else {
        return Err(WorkerError::new(
            "invalid-params",
            "exportVideoPayloadQueuePpm requires a path".to_string(),
        ));
    };
    let requested_channel_id = params.get("channelId").and_then(Value::as_str);
    let runtime = if let Some(channel_id) = requested_channel_id {
        state
            .video_runtimes
            .iter()
            .find(|runtime| runtime.channel_id == channel_id)
    } else {
        state.video_runtimes.first()
    };
    let Some(runtime) = runtime else {
        return Err(WorkerError::new(
            "native-media-error",
            "No running video payload queue is available".to_string(),
        ));
    };

    let result = runtime
        .export_payload_queue_ppm(PathBuf::from(path), max_frames, overwrite)
        .map_err(|message| WorkerError::new("native-media-error", message))?;
    emit_event("video", "payload-queue-ppm-exported", result.clone());
    Ok(result)
}

fn consume_audio_payload_queue(
    state: &mut WorkerState,
    params: &Value,
) -> Result<Value, WorkerError> {
    let max_packets = optional_u32(params, "maxPackets")
        .map_err(|message| WorkerError::new("invalid-params", message))?
        .unwrap_or(1)
        .clamp(1, 500);
    let Some(runtime) = state.audio_runtime.as_ref() else {
        return Err(WorkerError::new(
            "native-media-error",
            "No running audio payload queue is available".to_string(),
        ));
    };

    let result = runtime
        .consume_payload_queue(max_packets)
        .map_err(|message| WorkerError::new("native-media-error", message))?;
    emit_event("audio", "payload-queue-consumed", result.clone());
    Ok(result)
}

fn export_audio_payload_queue_wav(
    state: &mut WorkerState,
    params: &Value,
) -> Result<Value, WorkerError> {
    let max_packets = optional_u32(params, "maxPackets")
        .map_err(|message| WorkerError::new("invalid-params", message))?
        .unwrap_or(50)
        .clamp(1, 500);
    let overwrite = params
        .get("overwrite")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let Some(path) = params.get("path").and_then(Value::as_str) else {
        return Err(WorkerError::new(
            "invalid-params",
            "exportAudioPayloadQueueWav requires a path".to_string(),
        ));
    };
    let Some(runtime) = state.audio_runtime.as_ref() else {
        return Err(WorkerError::new(
            "native-media-error",
            "No running audio payload queue is available".to_string(),
        ));
    };

    let result = runtime
        .export_payload_queue_wav(PathBuf::from(path), max_packets, overwrite)
        .map_err(|message| WorkerError::new("native-media-error", message))?;
    emit_event("audio", "payload-queue-wav-exported", result.clone());
    Ok(result)
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
    let (video_format_preference, video_format_preference_error) =
        match video_format_preference_from_params(params) {
            Ok(preference) => (preference, Value::Null),
            Err(error) => (None, json!(error)),
        };
    let video_channel_bindings = params
        .get("videoChannelBindings")
        .cloned()
        .unwrap_or(Value::Null);
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
        build_video_session_start(
            records,
            requested_channels,
            video_media_type_index,
            video_format_preference.as_ref(),
            &video_channel_bindings,
        )
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
        "audioRender": [],
        "diagnostics": {
            "workerDeviceMode": "windows-native",
            "mediaFoundation": media_foundation_diag,
            "wasapi": wasapi_diag,
            "wasapiRender": {
                "status": "not-run",
                "reason": "capture-session-start-does-not-open-render-endpoints"
            }
        }
    });
    let capture_session = json!({
        "state": "running",
        "mode": "windows-native",
        "realMediaSession": bound_video_channels > 0 || bound_audio_endpoints > 0,
        "startedAt": started_at,
        "videoMediaTypeIndex": video_media_type_index,
        "videoFormatPreference": video_format_preference
            .as_ref()
            .map(VideoFormatPreference::to_json)
            .unwrap_or(Value::Null),
        "videoFormatPreferenceError": video_format_preference_error,
        "videoChannelBindings": video_channel_bindings,
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
        "videoPayloadCopyCount": 0,
        "videoPayloadCopyErrorCount": 0,
        "videoPayloadQueueBytes": 0,
        "videoPayloadTotalCopiedBytes": 0,
        "videoPayloadConsumeCount": 0,
        "videoPayloadConsumedBytes": 0,
        "audioPacketsProduced": 0,
        "audioFramesCaptured": 0,
        "audioBytesCaptured": 0,
        "audioPayloadCopyCount": 0,
        "audioPayloadCopyErrorCount": 0,
        "audioPayloadQueueBytes": 0,
        "audioPayloadTotalCopiedBytes": 0,
        "audioPayloadConsumeCount": 0,
        "audioPayloadConsumedBytes": 0,
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
    format_preference: Option<&VideoFormatPreference>,
    channel_bindings: &Value,
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
            let (record, device_binding) = match select_video_record_for_channel(
                &records,
                channel_id,
                index,
                channel_bindings,
            ) {
                Ok(binding) => binding,
                Err(error) => return unassigned_video_channel(channel_id, index, &error),
            };
            let Some(record) = record else {
                return unassigned_video_channel(
                    channel_id,
                    index,
                    "no-native-video-device-for-channel-index",
                );
            };
            bound_count += 1;
            let media_type_selection =
                select_video_media_type_for_record(record, media_type_index, format_preference);
            let (state, media_type_value, selection_value, media_error) = match media_type_selection
            {
                Ok(selection) => (
                    "native-bound",
                    selection.media_type,
                    selection.selection,
                    Value::Null,
                ),
                Err(error) => ("device-bound", Value::Null, Value::Null, json!(error)),
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
                "deviceBinding": device_binding,
                "mediaType": media_type_value,
                "requestedMediaTypeIndex": media_type_index,
                "mediaTypeSelection": selection_value,
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
        "channelBindingStatus": if channel_bindings.is_null() {
            "enumeration-order"
        } else {
            "explicit-supported"
        },
        "capabilitiesStatus": if format_preference.is_some() {
            "preferred-media-type-probed"
        } else {
            "default-media-type-probed"
        }
    });
    Ok((channels, devices, diag, bound_count))
}

fn select_video_record_for_channel<'a>(
    records: &'a [VideoDeviceActivate],
    channel_id: &str,
    fallback_index: usize,
    channel_bindings: &Value,
) -> Result<(Option<&'a VideoDeviceActivate>, Value), String> {
    let Some(selector) = video_channel_binding_selector(channel_bindings, channel_id) else {
        let record = records.get(fallback_index);
        return Ok((
            record,
            json!({
                "mode": "enumeration-order",
                "requestedChannelId": channel_id,
                "requestedIndex": fallback_index,
                "selectedIndex": record.map(|record| record.index),
                "selectedDeviceId": record.map(|record| record.device_id.clone())
            }),
        ));
    };

    let selector_index = if selector.is_u64() {
        selector
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
    } else {
        optional_u32(selector, "index")?
    };
    let selector_device_id = selector.get("deviceId").and_then(Value::as_str);
    let selector_native_id = selector.get("nativeId").and_then(Value::as_str);
    let selector_display_name_contains = selector
        .get("displayNameContains")
        .and_then(Value::as_str)
        .map(|value| value.to_ascii_lowercase());

    let record = records.iter().find(|record| {
        if let Some(index) = selector_index {
            if record.index == index {
                return true;
            }
        }
        if let Some(device_id) = selector_device_id {
            if record.device_id == device_id {
                return true;
            }
        }
        if let Some(native_id) = selector_native_id {
            if record.native_id == native_id {
                return true;
            }
        }
        if let Some(display_name_contains) = selector_display_name_contains.as_ref() {
            if record
                .display_name
                .to_ascii_lowercase()
                .contains(display_name_contains)
            {
                return true;
            }
        }
        false
    });

    let Some(record) = record else {
        return Err(format!(
            "video-channel-binding-not-found: channelId={channel_id}"
        ));
    };
    Ok((
        Some(record),
        json!({
            "mode": "explicit",
            "requestedChannelId": channel_id,
            "selector": selector,
            "fallbackIndex": fallback_index,
            "selectedIndex": record.index,
            "selectedDeviceId": record.device_id.clone(),
            "selectedNativeId": record.native_id.clone(),
            "selectedDisplayName": record.display_name.clone()
        }),
    ))
}

fn video_channel_binding_selector<'a>(
    channel_bindings: &'a Value,
    channel_id: &str,
) -> Option<&'a Value> {
    if channel_bindings.is_null() {
        return None;
    }
    if let Some(selector) = channel_bindings.get(channel_id) {
        return Some(selector);
    }
    channel_bindings.as_array()?.iter().find(|selector| {
        selector
            .get("channelId")
            .and_then(Value::as_str)
            .map(|value| value == channel_id)
            .unwrap_or(false)
    })
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
        "videoPayloadCopyCount": 0,
        "videoPayloadCopyErrorCount": 0,
        "videoPayloadQueueBytes": 0,
        "videoPayloadTotalCopiedBytes": 0,
        "videoPayloadConsumeCount": 0,
        "videoPayloadConsumedBytes": 0,
        "audioPacketsProduced": 0,
        "audioFramesCaptured": 0,
        "audioBytesCaptured": 0,
        "audioPayloadCopyCount": 0,
        "audioPayloadCopyErrorCount": 0,
        "audioPayloadQueueBytes": 0,
        "audioPayloadTotalCopiedBytes": 0,
        "audioPayloadConsumeCount": 0,
        "audioPayloadConsumedBytes": 0,
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

fn video_thread_start_targets(channels: &[Value], params: &Value) -> Vec<(String, u32, u32)> {
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
            let media_type_index = channel
                .get("mediaType")
                .and_then(|media_type| media_type.get("mediaTypeIndex"))
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .or_else(|| {
                    channel
                        .get("requestedMediaTypeIndex")
                        .and_then(Value::as_u64)
                        .and_then(|value| u32::try_from(value).ok())
                })
                .unwrap_or(0);
            Some((channel_id, video_index, media_type_index))
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
    let payload_queue = Arc::new(Mutex::new(VideoPayloadQueue::new()));
    let thread_stop = Arc::clone(&stop);
    let thread_stats = Arc::clone(&stats);
    let thread_payload_queue = Arc::clone(&payload_queue);
    let thread_channel_id = channel_id.clone();
    let handle = thread::spawn(move || {
        run_video_capture_thread(
            thread_channel_id,
            video_index,
            media_type_index,
            frame_queue_capacity,
            thread_stop,
            thread_stats,
            thread_payload_queue,
        );
    });
    VideoCaptureRuntime {
        channel_id,
        stop,
        stats,
        payload_queue,
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
    frame_queue_capacity: u32,
    stop: Arc<AtomicBool>,
    stats: Arc<Mutex<VideoCaptureThreadStats>>,
    payload_queue: Arc<Mutex<VideoPayloadQueue>>,
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
                        let payload_copy = copy_video_sample_payload(&sample);
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
                            match payload_copy {
                                Ok(payload) => {
                                    let sequence = stats.sample_count;
                                    let frame = VideoPayloadFrame {
                                        sequence,
                                        timestamp_hns,
                                        sample_time_hns,
                                        total_length_bytes: total_length,
                                        payload,
                                    };
                                    let push = payload_queue
                                        .lock()
                                        .map(|mut queue| queue.push(frame, frame_queue_capacity));
                                    match push {
                                        Ok(push) => {
                                            stats.frame_queue_push_count =
                                                stats.frame_queue_push_count.saturating_add(1);
                                            stats.frame_queue_latest_sequence =
                                                Some(stats.sample_count);
                                            stats.frame_queue_latest_timestamp_hns =
                                                Some(timestamp_hns);
                                            stats.frame_queue_latest_sample_time_hns =
                                                sample_time_hns;
                                            stats.frame_queue_latest_total_length_bytes =
                                                total_length;
                                            stats.frame_queue_depth = push.depth;
                                            stats.frame_payload_queue_depth = push.depth;
                                            stats.frame_payload_queue_bytes = push.bytes;
                                            stats.frame_payload_copy_count =
                                                stats.frame_payload_copy_count.saturating_add(1);
                                            stats.frame_payload_total_copied_bytes = stats
                                                .frame_payload_total_copied_bytes
                                                .saturating_add(u64::from(push.payload_bytes));
                                            stats.frame_payload_latest_bytes =
                                                Some(push.payload_bytes);
                                            if push.dropped_frame {
                                                stats.frame_queue_drop_count =
                                                    stats.frame_queue_drop_count.saturating_add(1);
                                                stats.frame_payload_dropped_bytes = stats
                                                    .frame_payload_dropped_bytes
                                                    .saturating_add(push.dropped_bytes);
                                            }
                                        }
                                        Err(_) => {
                                            stats.frame_payload_copy_error_count = stats
                                                .frame_payload_copy_error_count
                                                .saturating_add(1);
                                            stats.last_error = Some(
                                                "video payload queue lock poisoned".to_string(),
                                            );
                                        }
                                    }
                                }
                                Err(error) => {
                                    stats.frame_payload_copy_error_count =
                                        stats.frame_payload_copy_error_count.saturating_add(1);
                                    stats.last_error = Some(error);
                                }
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

fn copy_video_sample_payload(sample: &IMFSample) -> Result<Vec<u8>, String> {
    let buffer = unsafe {
        sample
            .ConvertToContiguousBuffer()
            .map_err(format_windows_error)?
    };
    let mut data_ptr: *mut u8 = ptr::null_mut();
    let mut max_length = 0u32;
    let mut current_length = 0u32;
    unsafe {
        buffer
            .Lock(
                &mut data_ptr,
                Some(&mut max_length),
                Some(&mut current_length),
            )
            .map_err(format_windows_error)?;
    }

    let payload = if current_length == 0 {
        Ok(Vec::new())
    } else if data_ptr.is_null() {
        Err("IMFMediaBuffer::Lock returned a null data pointer".to_string())
    } else {
        let bytes = unsafe { std::slice::from_raw_parts(data_ptr, current_length as usize) };
        Ok(bytes.to_vec())
    };
    let unlock = unsafe { buffer.Unlock().map_err(format_windows_error) };

    match (payload, unlock) {
        (Ok(payload), Ok(())) => Ok(payload),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(format!("IMFMediaBuffer::Unlock failed: {error}")),
        (Err(payload_error), Err(unlock_error)) => Err(format!(
            "{payload_error}; IMFMediaBuffer::Unlock failed: {unlock_error}"
        )),
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

    fn consume_payload_queue(&self, max_frames: u32) -> Result<Value, String> {
        let consume = self
            .payload_queue
            .lock()
            .map_err(|_| "video payload queue lock poisoned".to_string())?
            .consume(max_frames);
        self.update(|stats| {
            stats.frame_payload_queue_depth = consume.remaining_depth;
            stats.frame_queue_depth = consume.remaining_depth;
            stats.frame_payload_queue_bytes = consume.remaining_bytes;
            stats.frame_payload_consume_count = stats
                .frame_payload_consume_count
                .saturating_add(u64::from(consume.consumed_frames));
            stats.frame_payload_consumed_bytes = stats
                .frame_payload_consumed_bytes
                .saturating_add(consume.consumed_bytes);
            stats.frame_payload_latest_consumed_sequence = consume.latest_sequence;
            stats.frame_payload_consumer_status = "manual-drain".to_string();
        });

        Ok(json!({
            "status": if consume.consumed_frames > 0 { "consumed" } else { "empty" },
            "channelId": self.channel_id.clone(),
            "consumer": "manual-drain",
            "payloadTransport": "native-only",
            "exportedOverJson": false,
            "maxFrames": max_frames,
            "consumedFrames": consume.consumed_frames,
            "consumedBytes": consume.consumed_bytes,
            "latestSequence": consume.latest_sequence,
            "latestTimestampHns": consume.latest_timestamp_hns,
            "latestSampleTimeHns": consume.latest_sample_time_hns,
            "latestTotalLengthBytes": consume.latest_total_length_bytes,
            "remainingDepth": consume.remaining_depth,
            "remainingBytes": consume.remaining_bytes
        }))
    }

    fn export_payload_queue_pgm(
        &self,
        path: PathBuf,
        max_frames: u32,
        overwrite: bool,
    ) -> Result<Value, String> {
        let media_type = self
            .stats
            .lock()
            .map_err(|_| "video capture stats lock poisoned".to_string())?
            .media_type
            .clone();
        let pgm_format = video_nv12_format_from_media_type(&media_type)?;
        let drain = self
            .payload_queue
            .lock()
            .map_err(|_| "video payload queue lock poisoned".to_string())?
            .drain(max_frames);
        let consumed_frames = drain.frames.len() as u32;
        let latest_frame = drain.frames.last();
        let latest_sequence = latest_frame.map(|frame| frame.sequence);
        let latest_timestamp_hns = latest_frame.map(|frame| frame.timestamp_hns);
        let latest_sample_time_hns = latest_frame.and_then(|frame| frame.sample_time_hns);
        let latest_total_length_bytes = latest_frame.and_then(|frame| frame.total_length_bytes);
        if consumed_frames == 0 {
            return Ok(json!({
                "status": "empty",
                "channelId": self.channel_id.clone(),
                "consumer": "pgm-export",
                "payloadTransport": "native-only",
                "exportedOverJson": false,
                "maxFrames": max_frames,
                "consumedFrames": 0,
                "consumedBytes": 0,
                "remainingDepth": drain.remaining_depth,
                "remainingBytes": drain.remaining_bytes,
                "path": path.to_string_lossy().to_string()
            }));
        }

        let Some(frame) = latest_frame else {
            return Err("video payload queue export has no latest frame".to_string());
        };
        let pgm_bytes = build_pgm_bytes(&pgm_format, &frame.payload)?;
        write_binary_file(&path, &pgm_bytes, overwrite, "video PGM")?;
        let file_bytes = u64::try_from(pgm_bytes.len()).unwrap_or(u64::MAX);

        self.update(|stats| {
            stats.frame_payload_queue_depth = drain.remaining_depth;
            stats.frame_queue_depth = drain.remaining_depth;
            stats.frame_payload_queue_bytes = drain.remaining_bytes;
            stats.frame_payload_consume_count = stats
                .frame_payload_consume_count
                .saturating_add(u64::from(consumed_frames));
            stats.frame_payload_consumed_bytes = stats
                .frame_payload_consumed_bytes
                .saturating_add(drain.consumed_bytes);
            stats.frame_payload_latest_consumed_sequence = latest_sequence;
            stats.frame_payload_consumer_status = "pgm-export".to_string();
        });

        Ok(json!({
            "status": "exported",
            "channelId": self.channel_id.clone(),
            "consumer": "pgm-export",
            "payloadTransport": "native-only",
            "exportedOverJson": false,
            "fileFormat": "pgm",
            "path": path.to_string_lossy().to_string(),
            "maxFrames": max_frames,
            "consumedFrames": consumed_frames,
            "consumedBytes": drain.consumed_bytes,
            "fileBytes": file_bytes,
            "latestSequence": latest_sequence,
            "latestTimestampHns": latest_timestamp_hns,
            "latestSampleTimeHns": latest_sample_time_hns,
            "latestTotalLengthBytes": latest_total_length_bytes,
            "remainingDepth": drain.remaining_depth,
            "remainingBytes": drain.remaining_bytes,
            "imageFormat": {
                "format": "PGM",
                "sourceSubtype": pgm_format.subtype_fourcc,
                "width": pgm_format.width,
                "height": pgm_format.height,
                "sourceMediaType": pgm_format.source_format
            }
        }))
    }

    fn export_payload_queue_ppm(
        &self,
        path: PathBuf,
        max_frames: u32,
        overwrite: bool,
    ) -> Result<Value, String> {
        let media_type = self
            .stats
            .lock()
            .map_err(|_| "video capture stats lock poisoned".to_string())?
            .media_type
            .clone();
        let ppm_format = video_nv12_format_from_media_type(&media_type)?;
        let drain = self
            .payload_queue
            .lock()
            .map_err(|_| "video payload queue lock poisoned".to_string())?
            .drain(max_frames);
        let consumed_frames = drain.frames.len() as u32;
        let latest_frame = drain.frames.last();
        let latest_sequence = latest_frame.map(|frame| frame.sequence);
        let latest_timestamp_hns = latest_frame.map(|frame| frame.timestamp_hns);
        let latest_sample_time_hns = latest_frame.and_then(|frame| frame.sample_time_hns);
        let latest_total_length_bytes = latest_frame.and_then(|frame| frame.total_length_bytes);
        if consumed_frames == 0 {
            return Ok(json!({
                "status": "empty",
                "channelId": self.channel_id.clone(),
                "consumer": "ppm-export",
                "payloadTransport": "native-only",
                "exportedOverJson": false,
                "maxFrames": max_frames,
                "consumedFrames": 0,
                "consumedBytes": 0,
                "remainingDepth": drain.remaining_depth,
                "remainingBytes": drain.remaining_bytes,
                "path": path.to_string_lossy().to_string()
            }));
        }

        let Some(frame) = latest_frame else {
            return Err("video payload queue export has no latest frame".to_string());
        };
        let ppm_bytes = build_ppm_bytes(&ppm_format, &frame.payload)?;
        write_binary_file(&path, &ppm_bytes, overwrite, "video PPM")?;
        let file_bytes = u64::try_from(ppm_bytes.len()).unwrap_or(u64::MAX);

        self.update(|stats| {
            stats.frame_payload_queue_depth = drain.remaining_depth;
            stats.frame_queue_depth = drain.remaining_depth;
            stats.frame_payload_queue_bytes = drain.remaining_bytes;
            stats.frame_payload_consume_count = stats
                .frame_payload_consume_count
                .saturating_add(u64::from(consumed_frames));
            stats.frame_payload_consumed_bytes = stats
                .frame_payload_consumed_bytes
                .saturating_add(drain.consumed_bytes);
            stats.frame_payload_latest_consumed_sequence = latest_sequence;
            stats.frame_payload_consumer_status = "ppm-export".to_string();
        });

        Ok(json!({
            "status": "exported",
            "channelId": self.channel_id.clone(),
            "consumer": "ppm-export",
            "payloadTransport": "native-only",
            "exportedOverJson": false,
            "fileFormat": "ppm",
            "path": path.to_string_lossy().to_string(),
            "maxFrames": max_frames,
            "consumedFrames": consumed_frames,
            "consumedBytes": drain.consumed_bytes,
            "fileBytes": file_bytes,
            "latestSequence": latest_sequence,
            "latestTimestampHns": latest_timestamp_hns,
            "latestSampleTimeHns": latest_sample_time_hns,
            "latestTotalLengthBytes": latest_total_length_bytes,
            "remainingDepth": drain.remaining_depth,
            "remainingBytes": drain.remaining_bytes,
            "imageFormat": {
                "format": "PPM",
                "sourceSubtype": ppm_format.subtype_fourcc,
                "width": ppm_format.width,
                "height": ppm_format.height,
                "sourceMediaType": ppm_format.source_format
            }
        }))
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
            frame_payload_queue_depth: 0,
            frame_payload_queue_bytes: 0,
            frame_payload_copy_count: 0,
            frame_payload_copy_error_count: 0,
            frame_payload_total_copied_bytes: 0,
            frame_payload_dropped_bytes: 0,
            frame_payload_latest_bytes: None,
            frame_payload_consume_count: 0,
            frame_payload_consumed_bytes: 0,
            frame_payload_latest_consumed_sequence: None,
            frame_payload_consumer_status: "not-attached".to_string(),
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

fn start_audio_capture_runtime(
    audio_index: u32,
    poll_interval_ms: u32,
    payload_queue_capacity: u32,
) -> AudioCaptureRuntime {
    let stop = Arc::new(AtomicBool::new(false));
    let stats = Arc::new(Mutex::new(AudioCaptureThreadStats::new(
        audio_index,
        poll_interval_ms,
        payload_queue_capacity,
    )));
    let payload_queue = Arc::new(Mutex::new(AudioPayloadQueue::new()));
    let thread_stop = Arc::clone(&stop);
    let thread_stats = Arc::clone(&stats);
    let thread_payload_queue = Arc::clone(&payload_queue);
    let handle = thread::spawn(move || {
        run_audio_capture_thread(
            audio_index,
            poll_interval_ms,
            payload_queue_capacity,
            thread_stop,
            thread_stats,
            thread_payload_queue,
        );
    });
    AudioCaptureRuntime {
        stop,
        stats,
        payload_queue,
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
    payload_queue_capacity: u32,
    stop: Arc<AtomicBool>,
    stats: Arc<Mutex<AudioCaptureThreadStats>>,
    payload_queue: Arc<Mutex<AudioPayloadQueue>>,
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
                let audio_level_format = audio_level_format_label(format_ptr);
                update_audio_stats(&stats, |stats| {
                    stats.state = "starting".to_string();
                    stats.device = audio_device_record_to_json(record);
                    stats.mix_format = mix_format.clone();
                    stats.audio_level_format = audio_level_format.to_string();
                    stats.audio_level_status = if audio_level_format == "unsupported" {
                        "unsupported-format".to_string()
                    } else {
                        "waiting-for-packets".to_string()
                    };
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
                            let audio_level = measure_audio_level_packet(
                                data_ptr as *const u8,
                                frames_to_read,
                                flags,
                                format_ptr,
                            );
                            let payload_copy = copy_audio_packet_payload(
                                data_ptr as *const u8,
                                frames_to_read,
                                flags,
                                block_align,
                            );
                            update_audio_stats(&stats, |stats| {
                                let frame_count = u64::from(frames_to_read);
                                stats.packet_count = stats.packet_count.saturating_add(1);
                                let packet_sequence = stats.packet_count;
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
                                apply_audio_level_packet(stats, audio_level);
                                match payload_copy {
                                    Ok(payload) => {
                                        let packet = AudioPayloadPacket {
                                            sequence: packet_sequence,
                                            device_position: Some(device_position),
                                            qpc_position: Some(qpc_position),
                                            frames: frames_to_read,
                                            payload,
                                        };
                                        let push = payload_queue.lock().map(|mut queue| {
                                            queue.push(packet, payload_queue_capacity)
                                        });
                                        match push {
                                            Ok(push) => {
                                                stats.payload_queue_depth = push.depth;
                                                stats.payload_queue_bytes = push.bytes;
                                                stats.payload_queue_copy_count = stats
                                                    .payload_queue_copy_count
                                                    .saturating_add(1);
                                                stats.payload_queue_total_copied_bytes = stats
                                                    .payload_queue_total_copied_bytes
                                                    .saturating_add(u64::from(push.payload_bytes));
                                                stats.payload_queue_latest_bytes =
                                                    Some(push.payload_bytes);
                                                stats.payload_queue_latest_sequence =
                                                    Some(packet_sequence);
                                                if push.dropped_packet {
                                                    stats.payload_queue_drop_count = stats
                                                        .payload_queue_drop_count
                                                        .saturating_add(1);
                                                    stats.payload_queue_dropped_bytes = stats
                                                        .payload_queue_dropped_bytes
                                                        .saturating_add(push.dropped_bytes);
                                                }
                                            }
                                            Err(_) => {
                                                stats.payload_queue_copy_error_count = stats
                                                    .payload_queue_copy_error_count
                                                    .saturating_add(1);
                                                stats.last_error = Some(
                                                    "audio payload queue lock poisoned".to_string(),
                                                );
                                            }
                                        }
                                    }
                                    Err(error) => {
                                        stats.payload_queue_copy_error_count =
                                            stats.payload_queue_copy_error_count.saturating_add(1);
                                        stats.last_error = Some(error);
                                    }
                                }
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

fn copy_audio_packet_payload(
    data_ptr: *const u8,
    frames_to_read: u32,
    flags: u32,
    block_align: u64,
) -> Result<Vec<u8>, String> {
    let byte_count = u64::from(frames_to_read).saturating_mul(block_align);
    let Ok(byte_count) = usize::try_from(byte_count) else {
        return Err("audio packet payload is too large".to_string());
    };
    if byte_count == 0 {
        return Ok(Vec::new());
    }
    if has_audio_buffer_flag(flags, AUDCLNT_BUFFERFLAGS_SILENT.0) {
        return Ok(vec![0; byte_count]);
    }
    if data_ptr.is_null() {
        return Err("IAudioCaptureClient::GetBuffer returned a null data pointer".to_string());
    }
    let bytes = unsafe { std::slice::from_raw_parts(data_ptr, byte_count) };
    Ok(bytes.to_vec())
}

fn audio_wav_format_from_mix_format(mix_format: &Value) -> Result<AudioWavFormat, String> {
    if mix_format.is_null() {
        return Err("audio mix format is not available yet".to_string());
    }
    let source_format_tag = json_u16(mix_format, "formatTag")?;
    let sub_format_name = mix_format.get("subFormatName").and_then(Value::as_str);
    let format_tag = if source_format_tag == WAVE_FORMAT_PCM_TAG || sub_format_name == Some("PCM") {
        WAVE_FORMAT_PCM_TAG
    } else if source_format_tag == WAVE_FORMAT_IEEE_FLOAT_TAG
        || sub_format_name == Some("IEEE_FLOAT")
    {
        WAVE_FORMAT_IEEE_FLOAT_TAG
    } else {
        return Err(format!(
            "unsupported audio WAV export format: tag={source_format_tag}, subFormat={}",
            sub_format_name.unwrap_or("unknown")
        ));
    };
    let channels = json_u16(mix_format, "channels")?.max(1);
    let samples_per_sec = json_u32(mix_format, "samplesPerSec")?.max(1);
    let bits_per_sample = json_u16(mix_format, "bitsPerSample")?.max(1);
    let block_align = mix_format
        .get("blockAlign")
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .unwrap_or_else(|| channels.saturating_mul(bits_per_sample / 8))
        .max(1);
    let avg_bytes_per_sec = mix_format
        .get("avgBytesPerSec")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or_else(|| samples_per_sec.saturating_mul(u32::from(block_align)))
        .max(1);

    Ok(AudioWavFormat {
        format_tag,
        channels,
        samples_per_sec,
        avg_bytes_per_sec,
        block_align,
        bits_per_sample,
        source_format: mix_format.clone(),
    })
}

fn build_wav_bytes(format: &AudioWavFormat, audio_data: &[u8]) -> Result<Vec<u8>, String> {
    let data_size = u32::try_from(audio_data.len())
        .map_err(|_| "audio WAV data is too large for a RIFF/WAVE file".to_string())?;
    let riff_size = 36u32
        .checked_add(data_size)
        .ok_or_else(|| "audio WAV RIFF size overflow".to_string())?;
    let mut bytes = Vec::with_capacity(44usize.saturating_add(audio_data.len()));
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&riff_size.to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(b"fmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&format.format_tag.to_le_bytes());
    bytes.extend_from_slice(&format.channels.to_le_bytes());
    bytes.extend_from_slice(&format.samples_per_sec.to_le_bytes());
    bytes.extend_from_slice(&format.avg_bytes_per_sec.to_le_bytes());
    bytes.extend_from_slice(&format.block_align.to_le_bytes());
    bytes.extend_from_slice(&format.bits_per_sample.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_size.to_le_bytes());
    bytes.extend_from_slice(audio_data);
    Ok(bytes)
}

fn video_nv12_format_from_media_type(media_type: &Value) -> Result<VideoNv12FrameFormat, String> {
    if media_type.is_null() {
        return Err("video media type is not available yet".to_string());
    }
    let subtype_fourcc = media_type
        .get("subtypeFourCc")
        .or_else(|| media_type.get("subtype"))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    if subtype_fourcc != "NV12" {
        return Err(format!(
            "unsupported video frame export subtype: {subtype_fourcc}; only NV12 is supported"
        ));
    }
    let width = media_type
        .get("width")
        .and_then(Value::as_u64)
        .and_then(|raw| u32::try_from(raw).ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| "video media type width is missing or invalid".to_string())?;
    let height = media_type
        .get("height")
        .and_then(Value::as_u64)
        .and_then(|raw| u32::try_from(raw).ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| "video media type height is missing or invalid".to_string())?;

    Ok(VideoNv12FrameFormat {
        width,
        height,
        subtype_fourcc,
        source_format: media_type.clone(),
    })
}

fn build_pgm_bytes(format: &VideoNv12FrameFormat, payload: &[u8]) -> Result<Vec<u8>, String> {
    let luma_bytes = u64::from(format.width)
        .checked_mul(u64::from(format.height))
        .ok_or_else(|| "video PGM luma size overflow".to_string())?;
    let luma_bytes =
        usize::try_from(luma_bytes).map_err(|_| "video PGM luma size is too large".to_string())?;
    if payload.len() < luma_bytes {
        return Err(format!(
            "video payload is too small for NV12 luma plane: payload={}, required={luma_bytes}",
            payload.len()
        ));
    }
    let header = format!("P5\n{} {}\n255\n", format.width, format.height);
    let mut bytes = Vec::with_capacity(header.len().saturating_add(luma_bytes));
    bytes.extend_from_slice(header.as_bytes());
    bytes.extend_from_slice(&payload[..luma_bytes]);
    Ok(bytes)
}

fn build_ppm_bytes(format: &VideoNv12FrameFormat, payload: &[u8]) -> Result<Vec<u8>, String> {
    let width =
        usize::try_from(format.width).map_err(|_| "video PPM width is too large".to_string())?;
    let height =
        usize::try_from(format.height).map_err(|_| "video PPM height is too large".to_string())?;
    let luma_bytes = width
        .checked_mul(height)
        .ok_or_else(|| "video PPM luma size overflow".to_string())?;
    let chroma_bytes = luma_bytes / 2;
    let required_bytes = luma_bytes
        .checked_add(chroma_bytes)
        .ok_or_else(|| "video PPM NV12 size overflow".to_string())?;
    if payload.len() < required_bytes {
        return Err(format!(
            "video payload is too small for NV12 RGB conversion: payload={}, required={required_bytes}",
            payload.len()
        ));
    }

    let header = format!("P6\n{} {}\n255\n", format.width, format.height);
    let rgb_bytes = luma_bytes
        .checked_mul(3)
        .ok_or_else(|| "video PPM RGB size overflow".to_string())?;
    let mut bytes = Vec::with_capacity(header.len().saturating_add(rgb_bytes));
    bytes.extend_from_slice(header.as_bytes());

    for y in 0..height {
        let y_row = y * width;
        let uv_row = luma_bytes + (y / 2) * width;
        for x in 0..width {
            let y_value = payload[y_row + x] as i32;
            let uv_index = uv_row + (x / 2) * 2;
            let u_value = payload[uv_index] as i32;
            let v_value = payload[uv_index + 1] as i32;
            let (r, g, b) = nv12_to_rgb(y_value, u_value, v_value);
            bytes.push(r);
            bytes.push(g);
            bytes.push(b);
        }
    }

    Ok(bytes)
}

fn nv12_to_rgb(y: i32, u: i32, v: i32) -> (u8, u8, u8) {
    let c = (y - 16).max(0);
    let d = u - 128;
    let e = v - 128;
    let r = (298 * c + 409 * e + 128) >> 8;
    let g = (298 * c - 100 * d - 208 * e + 128) >> 8;
    let b = (298 * c + 516 * d + 128) >> 8;
    (clamp_u8(r), clamp_u8(g), clamp_u8(b))
}

fn clamp_u8(value: i32) -> u8 {
    value.clamp(0, 255) as u8
}

fn write_binary_file(
    path: &PathBuf,
    bytes: &[u8],
    overwrite: bool,
    label: &str,
) -> Result<(), String> {
    if path.exists() && !overwrite {
        return Err(format!(
            "{label} output already exists: {}",
            path.to_string_lossy()
        ));
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "failed to create {label} output directory {}: {error}",
                    parent.to_string_lossy()
                )
            })?;
        }
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .map_err(|error| {
            format!(
                "failed to open {label} output {}: {error}",
                path.to_string_lossy()
            )
        })?;
    file.write_all(bytes).map_err(|error| {
        format!(
            "failed to write {label} output {}: {error}",
            path.to_string_lossy()
        )
    })
}

fn write_wav_file(path: &PathBuf, bytes: &[u8], overwrite: bool) -> Result<(), String> {
    if path.exists() && !overwrite {
        return Err(format!(
            "audio WAV output already exists: {}",
            path.to_string_lossy()
        ));
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "failed to create audio WAV output directory {}: {error}",
                    parent.to_string_lossy()
                )
            })?;
        }
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .map_err(|error| {
            format!(
                "failed to open audio WAV output {}: {error}",
                path.to_string_lossy()
            )
        })?;
    file.write_all(bytes).map_err(|error| {
        format!(
            "failed to write audio WAV output {}: {error}",
            path.to_string_lossy()
        )
    })
}

fn json_u16(value: &Value, key: &str) -> Result<u16, String> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|raw| u16::try_from(raw).ok())
        .ok_or_else(|| format!("audio mix format field {key} is missing or invalid"))
}

fn json_u32(value: &Value, key: &str) -> Result<u32, String> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|raw| u32::try_from(raw).ok())
        .ok_or_else(|| format!("audio mix format field {key} is missing or invalid"))
}

fn apply_audio_level_packet(
    stats: &mut AudioCaptureThreadStats,
    packet: AudioLevelPacketMeasurement,
) {
    stats.audio_level_format = packet.format.to_string();
    if packet.status == "unsupported-format" {
        stats.audio_level_status = "unsupported-format".to_string();
        stats.audio_level_unsupported_packets =
            stats.audio_level_unsupported_packets.saturating_add(1);
        stats.audio_level_last_packet_frames =
            Some(u32::try_from(packet.frame_count).unwrap_or(u32::MAX));
        return;
    }
    stats.audio_level_status = packet.status.to_string();
    stats.audio_level_sample_count = stats
        .audio_level_sample_count
        .saturating_add(packet.sample_count);
    stats.audio_level_frame_count = stats
        .audio_level_frame_count
        .saturating_add(packet.frame_count);
    stats.audio_level_sum_squares += packet.sum_squares;
    stats.audio_level_peak = stats.audio_level_peak.max(packet.peak);
    stats.audio_level_last_rms = if packet.sample_count > 0 {
        Some((packet.sum_squares / packet.sample_count as f64).sqrt())
    } else {
        Some(0.0)
    };
    stats.audio_level_last_peak = Some(packet.peak);
    stats.audio_level_last_packet_frames =
        Some(u32::try_from(packet.frame_count).unwrap_or(u32::MAX));
}

fn measure_audio_level_packet(
    data_ptr: *const u8,
    frames_to_read: u32,
    flags: u32,
    format_ptr: *const WAVEFORMATEX,
) -> AudioLevelPacketMeasurement {
    let format_label = audio_level_format_label(format_ptr);
    let format = unsafe { *format_ptr };
    let channels = u64::from(format.nChannels.max(1));
    let frame_count = u64::from(frames_to_read);
    let sample_count = frame_count.saturating_mul(channels);
    if frames_to_read == 0 || sample_count == 0 {
        return AudioLevelPacketMeasurement {
            status: "measured",
            format: format_label,
            frame_count,
            sample_count: 0,
            sum_squares: 0.0,
            peak: 0.0,
        };
    }
    if has_audio_buffer_flag(flags, AUDCLNT_BUFFERFLAGS_SILENT.0) {
        return AudioLevelPacketMeasurement {
            status: "measured",
            format: format_label,
            frame_count,
            sample_count,
            sum_squares: 0.0,
            peak: 0.0,
        };
    }
    if data_ptr.is_null() || format_label == "unsupported" {
        return AudioLevelPacketMeasurement {
            status: "unsupported-format",
            format: format_label,
            frame_count,
            sample_count: 0,
            sum_squares: 0.0,
            peak: 0.0,
        };
    }
    let Ok(sample_count_usize) = usize::try_from(sample_count) else {
        return AudioLevelPacketMeasurement {
            status: "unsupported-format",
            format: "too-many-samples",
            frame_count,
            sample_count: 0,
            sum_squares: 0.0,
            peak: 0.0,
        };
    };

    match format_label {
        "float32" => {
            measure_f32_audio_samples(data_ptr.cast::<f32>(), sample_count_usize, frame_count)
        }
        "pcm16" => {
            measure_i16_audio_samples(data_ptr.cast::<i16>(), sample_count_usize, frame_count)
        }
        "pcm32" => {
            measure_i32_audio_samples(data_ptr.cast::<i32>(), sample_count_usize, frame_count)
        }
        _ => AudioLevelPacketMeasurement {
            status: "unsupported-format",
            format: format_label,
            frame_count,
            sample_count: 0,
            sum_squares: 0.0,
            peak: 0.0,
        },
    }
}

fn measure_f32_audio_samples(
    data_ptr: *const f32,
    sample_count: usize,
    frame_count: u64,
) -> AudioLevelPacketMeasurement {
    let samples = unsafe { std::slice::from_raw_parts(data_ptr, sample_count) };
    let mut sum_squares = 0.0f64;
    let mut peak = 0.0f64;
    for sample in samples {
        let value = if sample.is_finite() {
            f64::from(*sample).clamp(-1.0, 1.0)
        } else {
            0.0
        };
        let abs = value.abs();
        peak = peak.max(abs);
        sum_squares += value * value;
    }
    AudioLevelPacketMeasurement {
        status: "measured",
        format: "float32",
        frame_count,
        sample_count: sample_count as u64,
        sum_squares,
        peak,
    }
}

fn measure_i16_audio_samples(
    data_ptr: *const i16,
    sample_count: usize,
    frame_count: u64,
) -> AudioLevelPacketMeasurement {
    let samples = unsafe { std::slice::from_raw_parts(data_ptr, sample_count) };
    let mut sum_squares = 0.0f64;
    let mut peak = 0.0f64;
    for sample in samples {
        let value = f64::from(*sample) / 32768.0;
        let abs = value.abs();
        peak = peak.max(abs);
        sum_squares += value * value;
    }
    AudioLevelPacketMeasurement {
        status: "measured",
        format: "pcm16",
        frame_count,
        sample_count: sample_count as u64,
        sum_squares,
        peak,
    }
}

fn measure_i32_audio_samples(
    data_ptr: *const i32,
    sample_count: usize,
    frame_count: u64,
) -> AudioLevelPacketMeasurement {
    let samples = unsafe { std::slice::from_raw_parts(data_ptr, sample_count) };
    let mut sum_squares = 0.0f64;
    let mut peak = 0.0f64;
    for sample in samples {
        let value = f64::from(*sample) / 2_147_483_648.0;
        let abs = value.abs();
        peak = peak.max(abs);
        sum_squares += value * value;
    }
    AudioLevelPacketMeasurement {
        status: "measured",
        format: "pcm32",
        frame_count,
        sample_count: sample_count as u64,
        sum_squares,
        peak,
    }
}

fn audio_level_format_label(format_ptr: *const WAVEFORMATEX) -> &'static str {
    if format_ptr.is_null() {
        return "unsupported";
    }
    let format = unsafe { *format_ptr };
    let format_tag = effective_wave_format_tag(format_ptr).unwrap_or(format.wFormatTag);
    match (format_tag, format.wBitsPerSample) {
        (WAVE_FORMAT_IEEE_FLOAT_TAG, 32) => "float32",
        (WAVE_FORMAT_PCM_TAG, 16) => "pcm16",
        (WAVE_FORMAT_PCM_TAG, 32) => "pcm32",
        _ => "unsupported",
    }
}

fn effective_wave_format_tag(format_ptr: *const WAVEFORMATEX) -> Option<u16> {
    if format_ptr.is_null() {
        return None;
    }
    let format = unsafe { *format_ptr };
    if format.wFormatTag != WAVE_FORMAT_EXTENSIBLE_TAG {
        return Some(format.wFormatTag);
    }
    let extensible_extra_size =
        std::mem::size_of::<WAVEFORMATEXTENSIBLE>() - std::mem::size_of::<WAVEFORMATEX>();
    if usize::from(format.cbSize) < extensible_extra_size {
        return None;
    }
    let extensible = unsafe { *(format_ptr.cast::<WAVEFORMATEXTENSIBLE>()) };
    let sub_format = extensible.SubFormat;
    wave_subformat_tag(&sub_format)
}

fn wave_subformat_tag(guid: &GUID) -> Option<u16> {
    let wave_format_tail = [0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
    if guid.data2 == 0 && guid.data3 == 0x0010 && guid.data4 == wave_format_tail {
        Some(guid.data1 as u16)
    } else {
        None
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

    fn consume_payload_queue(&self, max_packets: u32) -> Result<Value, String> {
        let consume = self
            .payload_queue
            .lock()
            .map_err(|_| "audio payload queue lock poisoned".to_string())?
            .consume(max_packets);
        self.update(|stats| {
            stats.payload_queue_depth = consume.remaining_depth;
            stats.payload_queue_bytes = consume.remaining_bytes;
            stats.payload_queue_consume_count = stats
                .payload_queue_consume_count
                .saturating_add(u64::from(consume.consumed_packets));
            stats.payload_queue_consumed_bytes = stats
                .payload_queue_consumed_bytes
                .saturating_add(consume.consumed_bytes);
            stats.payload_queue_latest_consumed_sequence = consume.latest_sequence;
            stats.payload_queue_consumer_status = "manual-drain".to_string();
        });

        Ok(json!({
            "status": if consume.consumed_packets > 0 { "consumed" } else { "empty" },
            "consumer": "manual-drain",
            "payloadTransport": "native-only",
            "exportedOverJson": false,
            "maxPackets": max_packets,
            "consumedPackets": consume.consumed_packets,
            "consumedBytes": consume.consumed_bytes,
            "latestSequence": consume.latest_sequence,
            "latestDevicePosition": consume.latest_device_position,
            "latestQpcPosition": consume.latest_qpc_position,
            "latestFrames": consume.latest_frames,
            "remainingDepth": consume.remaining_depth,
            "remainingBytes": consume.remaining_bytes
        }))
    }

    fn export_payload_queue_wav(
        &self,
        path: PathBuf,
        max_packets: u32,
        overwrite: bool,
    ) -> Result<Value, String> {
        let mix_format = self
            .stats
            .lock()
            .map_err(|_| "audio capture stats lock poisoned".to_string())?
            .mix_format
            .clone();
        let wav_format = audio_wav_format_from_mix_format(&mix_format)?;
        let drain = self
            .payload_queue
            .lock()
            .map_err(|_| "audio payload queue lock poisoned".to_string())?
            .drain(max_packets);
        let consumed_packets = drain.packets.len() as u32;
        let latest_packet = drain.packets.last();
        let latest_sequence = latest_packet.map(|packet| packet.sequence);
        let latest_device_position = latest_packet.and_then(|packet| packet.device_position);
        let latest_qpc_position = latest_packet.and_then(|packet| packet.qpc_position);
        let latest_frames = latest_packet.map(|packet| packet.frames);
        if consumed_packets == 0 {
            return Ok(json!({
                "status": "empty",
                "consumer": "wav-export",
                "payloadTransport": "native-only",
                "exportedOverJson": false,
                "maxPackets": max_packets,
                "consumedPackets": 0,
                "consumedBytes": 0,
                "remainingDepth": drain.remaining_depth,
                "remainingBytes": drain.remaining_bytes,
                "path": path.to_string_lossy().to_string()
            }));
        }

        let mut audio_data = Vec::new();
        for packet in drain.packets {
            audio_data.extend_from_slice(&packet.payload);
        }
        let wav_bytes = build_wav_bytes(&wav_format, &audio_data)?;
        write_wav_file(&path, &wav_bytes, overwrite)?;
        let file_bytes = u64::try_from(wav_bytes.len()).unwrap_or(u64::MAX);
        let data_bytes = u64::try_from(audio_data.len()).unwrap_or(u64::MAX);

        self.update(|stats| {
            stats.payload_queue_depth = drain.remaining_depth;
            stats.payload_queue_bytes = drain.remaining_bytes;
            stats.payload_queue_consume_count = stats
                .payload_queue_consume_count
                .saturating_add(u64::from(consumed_packets));
            stats.payload_queue_consumed_bytes = stats
                .payload_queue_consumed_bytes
                .saturating_add(data_bytes);
            stats.payload_queue_latest_consumed_sequence = latest_sequence;
            stats.payload_queue_consumer_status = "wav-export".to_string();
        });

        Ok(json!({
            "status": "exported",
            "consumer": "wav-export",
            "payloadTransport": "native-only",
            "exportedOverJson": false,
            "fileFormat": "wav",
            "path": path.to_string_lossy().to_string(),
            "maxPackets": max_packets,
            "consumedPackets": consumed_packets,
            "consumedBytes": data_bytes,
            "fileBytes": file_bytes,
            "latestSequence": latest_sequence,
            "latestDevicePosition": latest_device_position,
            "latestQpcPosition": latest_qpc_position,
            "latestFrames": latest_frames,
            "remainingDepth": drain.remaining_depth,
            "remainingBytes": drain.remaining_bytes,
            "waveFormat": {
                "formatTag": wav_format.format_tag,
                "formatTagName": wave_format_tag_name(wav_format.format_tag),
                "channels": wav_format.channels,
                "samplesPerSec": wav_format.samples_per_sec,
                "avgBytesPerSec": wav_format.avg_bytes_per_sec,
                "blockAlign": wav_format.block_align,
                "bitsPerSample": wav_format.bits_per_sample,
                "sourceMixFormat": wav_format.source_format
            }
        }))
    }
}

impl AudioCaptureThreadStats {
    fn new(device_index: u32, poll_interval_ms: u32, payload_queue_capacity: u32) -> Self {
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
            audio_level_status: "not-started".to_string(),
            audio_level_format: "unknown".to_string(),
            audio_level_sample_count: 0,
            audio_level_frame_count: 0,
            audio_level_sum_squares: 0.0,
            audio_level_peak: 0.0,
            audio_level_last_rms: None,
            audio_level_last_peak: None,
            audio_level_last_packet_frames: None,
            audio_level_unsupported_packets: 0,
            payload_queue_capacity,
            payload_queue_depth: 0,
            payload_queue_bytes: 0,
            payload_queue_copy_count: 0,
            payload_queue_copy_error_count: 0,
            payload_queue_drop_count: 0,
            payload_queue_consume_count: 0,
            payload_queue_total_copied_bytes: 0,
            payload_queue_consumed_bytes: 0,
            payload_queue_dropped_bytes: 0,
            payload_queue_latest_bytes: None,
            payload_queue_latest_sequence: None,
            payload_queue_latest_consumed_sequence: None,
            payload_queue_consumer_status: "not-attached".to_string(),
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
        if let Some(payload_queue) = audio_stats.get("payloadQueue") {
            stats["audioPayloadCopyCount"] = payload_queue
                .get("copyCount")
                .cloned()
                .unwrap_or_else(|| json!(0));
            stats["audioPayloadCopyErrorCount"] = payload_queue
                .get("copyErrorCount")
                .cloned()
                .unwrap_or_else(|| json!(0));
            stats["audioPayloadQueueBytes"] = payload_queue
                .get("bytes")
                .cloned()
                .unwrap_or_else(|| json!(0));
            stats["audioPayloadTotalCopiedBytes"] = payload_queue
                .get("totalCopiedBytes")
                .cloned()
                .unwrap_or_else(|| json!(0));
            stats["audioPayloadConsumeCount"] = payload_queue
                .get("consumeCount")
                .cloned()
                .unwrap_or_else(|| json!(0));
            stats["audioPayloadConsumedBytes"] = payload_queue
                .get("consumedBytes")
                .cloned()
                .unwrap_or_else(|| json!(0));
        }
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
        let payload_copy_count = video_stats
            .iter()
            .filter_map(|stats| {
                stats
                    .get("frameQueue")
                    .and_then(|queue| queue.get("payloadQueue"))
                    .and_then(|queue| queue.get("copyCount"))
                    .and_then(Value::as_u64)
            })
            .sum::<u64>();
        let payload_copy_error_count = video_stats
            .iter()
            .filter_map(|stats| {
                stats
                    .get("frameQueue")
                    .and_then(|queue| queue.get("payloadQueue"))
                    .and_then(|queue| queue.get("copyErrorCount"))
                    .and_then(Value::as_u64)
            })
            .sum::<u64>();
        let payload_queue_bytes = video_stats
            .iter()
            .filter_map(|stats| {
                stats
                    .get("frameQueue")
                    .and_then(|queue| queue.get("payloadQueue"))
                    .and_then(|queue| queue.get("bytes"))
                    .and_then(Value::as_u64)
            })
            .sum::<u64>();
        let payload_total_copied_bytes = video_stats
            .iter()
            .filter_map(|stats| {
                stats
                    .get("frameQueue")
                    .and_then(|queue| queue.get("payloadQueue"))
                    .and_then(|queue| queue.get("totalCopiedBytes"))
                    .and_then(Value::as_u64)
            })
            .sum::<u64>();
        let payload_consume_count = video_stats
            .iter()
            .filter_map(|stats| {
                stats
                    .get("frameQueue")
                    .and_then(|queue| queue.get("payloadQueue"))
                    .and_then(|queue| queue.get("consumeCount"))
                    .and_then(Value::as_u64)
            })
            .sum::<u64>();
        let payload_consumed_bytes = video_stats
            .iter()
            .filter_map(|stats| {
                stats
                    .get("frameQueue")
                    .and_then(|queue| queue.get("payloadQueue"))
                    .and_then(|queue| queue.get("consumedBytes"))
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
        stats["videoPayloadCopyCount"] = json!(payload_copy_count);
        stats["videoPayloadCopyErrorCount"] = json!(payload_copy_error_count);
        stats["videoPayloadQueueBytes"] = json!(payload_queue_bytes);
        stats["videoPayloadTotalCopiedBytes"] = json!(payload_total_copied_bytes);
        stats["videoPayloadConsumeCount"] = json!(payload_consume_count);
        stats["videoPayloadConsumedBytes"] = json!(payload_consumed_bytes);
    }
    stats
}

fn audio_capture_thread_stats_to_json(stats: &AudioCaptureThreadStats) -> Value {
    let audio_level_rms = if stats.audio_level_sample_count > 0 {
        Some((stats.audio_level_sum_squares / stats.audio_level_sample_count as f64).sqrt())
    } else {
        None
    };
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
        "audioLevel": {
            "status": stats.audio_level_status,
            "format": stats.audio_level_format,
            "sampleCount": stats.audio_level_sample_count,
            "frameCount": stats.audio_level_frame_count,
            "rms": audio_level_rms,
            "peak": stats.audio_level_peak,
            "lastPacketRms": stats.audio_level_last_rms,
            "lastPacketPeak": stats.audio_level_last_peak,
            "lastPacketFrames": stats.audio_level_last_packet_frames,
            "unsupportedPackets": stats.audio_level_unsupported_packets
        },
        "payloadQueue": {
            "mode": "pcm-packet-bounded",
            "transport": "native-only",
            "exportedOverJson": false,
            "consumerStatus": stats.payload_queue_consumer_status.clone(),
            "capacity": stats.payload_queue_capacity,
            "depth": stats.payload_queue_depth,
            "bytes": stats.payload_queue_bytes,
            "copyCount": stats.payload_queue_copy_count,
            "copyErrorCount": stats.payload_queue_copy_error_count,
            "dropCount": stats.payload_queue_drop_count,
            "consumeCount": stats.payload_queue_consume_count,
            "totalCopiedBytes": stats.payload_queue_total_copied_bytes,
            "consumedBytes": stats.payload_queue_consumed_bytes,
            "droppedBytes": stats.payload_queue_dropped_bytes,
            "latestBytes": stats.payload_queue_latest_bytes,
            "latestSequence": stats.payload_queue_latest_sequence,
            "latestConsumedSequence": stats.payload_queue_latest_consumed_sequence
        },
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
            "mode": "native-payload-bounded",
            "payloadTransport": "native-only",
            "consumerStatus": stats.frame_payload_consumer_status.clone(),
            "capacity": stats.frame_queue_capacity,
            "depth": stats.frame_queue_depth,
            "pushCount": stats.frame_queue_push_count,
            "dropCount": stats.frame_queue_drop_count,
            "latestSequence": stats.frame_queue_latest_sequence,
            "latestTimestampHns": stats.frame_queue_latest_timestamp_hns,
            "latestSampleTimeHns": stats.frame_queue_latest_sample_time_hns,
            "latestTotalLengthBytes": stats.frame_queue_latest_total_length_bytes,
            "payloadQueue": {
                "mode": "copied-bounded",
                "transport": "native-only",
                "exportedOverJson": false,
                "depth": stats.frame_payload_queue_depth,
                "bytes": stats.frame_payload_queue_bytes,
                "copyCount": stats.frame_payload_copy_count,
                "copyErrorCount": stats.frame_payload_copy_error_count,
                "consumeCount": stats.frame_payload_consume_count,
                "totalCopiedBytes": stats.frame_payload_total_copied_bytes,
                "consumedBytes": stats.frame_payload_consumed_bytes,
                "droppedBytes": stats.frame_payload_dropped_bytes,
                "latestBytes": stats.frame_payload_latest_bytes,
                "latestConsumedSequence": stats.frame_payload_latest_consumed_sequence
            }
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
        "audioRender": [
            {
                "deviceId": "mock-native-audio-render-room",
                "displayName": "Mock Native Room Playback Device",
                "transport": "system-audio-output",
                "role": "room-speaker",
                "backend": "mock-native",
                "nativeId": "mock-native-audio-render-room",
                "dataFlow": "render",
                "state": "active",
                "capabilities": [{ "sampleRate": 48000, "channels": 2 }]
            }
        ],
        "diagnostics": {
            "workerDeviceMode": "mock-native",
            "mediaFoundation": { "status": "mock", "count": 4 },
            "wasapi": { "status": "mock", "count": 1 },
            "wasapiRender": { "status": "mock", "count": 1 }
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
                "wasapi": { "status": "not-run" },
                "wasapiRender": { "status": "not-run" }
            });
            return devices;
        }
    };

    let video_result = enumerate_video_devices();
    let audio_result = enumerate_audio_capture_devices();
    let audio_render_result = enumerate_audio_render_devices();
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

    let (audio_render, wasapi_render_diag) = match audio_render_result {
        Ok(audio_render) => {
            let count = audio_render.len();
            (
                audio_render,
                json!({
                    "status": "ok",
                    "count": count,
                    "backend": "wasapi",
                    "dataFlow": "render",
                    "capabilitiesStatus": "not-enumerated"
                }),
            )
        }
        Err(error) => (
            Vec::new(),
            json!({
                "status": "failed",
                "backend": "wasapi",
                "dataFlow": "render",
                "error": error
            }),
        ),
    };

    let media_foundation_failed = media_foundation_diag["status"] == "failed";
    let wasapi_failed = wasapi_diag["status"] == "failed";
    let wasapi_render_failed = wasapi_render_diag["status"] == "failed";
    if media_foundation_failed && wasapi_failed && wasapi_render_failed {
        let mut devices = mock_devices();
        devices["source"] = json!("mock-fallback");
        devices["diagnostics"] = json!({
            "workerDeviceMode": "mock-fallback",
            "reason": "native-enumeration-failed",
            "mediaFoundation": media_foundation_diag,
            "wasapi": wasapi_diag,
            "wasapiRender": wasapi_render_diag
        });
        return devices;
    }

    json!({
        "source": "windows-native",
        "video": video,
        "audio": audio,
        "audioRender": audio_render,
        "diagnostics": {
            "workerDeviceMode": "windows-native",
            "mediaFoundation": media_foundation_diag,
            "wasapi": wasapi_diag,
            "wasapiRender": wasapi_render_diag
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

fn select_video_media_type_for_record(
    record: &VideoDeviceActivate,
    fallback_media_type_index: u32,
    format_preference: Option<&VideoFormatPreference>,
) -> Result<VideoMediaTypeSelection, String> {
    let Some(preference) = format_preference else {
        let media_type = read_video_media_type_for_record(record, fallback_media_type_index)?;
        return Ok(VideoMediaTypeSelection {
            media_type: media_type.clone(),
            selection: json!({
                "mode": "index",
                "requestedIndex": fallback_media_type_index,
                "selectedIndex": fallback_media_type_index,
                "preference": Value::Null,
                "score": Value::Null,
                "match": Value::Null
            }),
        });
    };

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
        let mut best: Option<(u32, Value, f64, Value)> = None;
        let mut inspected_count = 0u32;
        for media_type_index in 0..preference.max_media_types {
            let media_type = match unsafe {
                reader.GetNativeMediaType(video_stream_index(), media_type_index)
            } {
                Ok(media_type) => media_type,
                Err(_) => break,
            };
            inspected_count = inspected_count.saturating_add(1);
            let media_type_json = media_type_to_json(&media_type, media_type_index);
            let (score, match_details) = score_video_media_type(&media_type_json, preference);
            let replace_best = best
                .as_ref()
                .map(|(_, _, best_score, _)| score < *best_score)
                .unwrap_or(true);
            if replace_best {
                best = Some((media_type_index, media_type_json, score, match_details));
            }
        }

        let Some((selected_index, media_type, score, match_details)) = best else {
            return Err(format!(
                "No video media types were available for preference scan. maxMediaTypes={}",
                preference.max_media_types
            ));
        };

        Ok(VideoMediaTypeSelection {
            media_type,
            selection: json!({
                "mode": "preference",
                "requestedIndexFallback": fallback_media_type_index,
                "selectedIndex": selected_index,
                "inspectedMediaTypes": inspected_count,
                "preference": preference.to_json(),
                "score": score,
                "match": match_details
            }),
        })
    })();
    shutdown_media_source(&source, &record.activate);
    result
}

fn score_video_media_type(media_type: &Value, preference: &VideoFormatPreference) -> (f64, Value) {
    let subtype = media_type
        .get("subtypeFourCc")
        .or_else(|| media_type.get("subtype"))
        .and_then(Value::as_str)
        .map(String::from);
    let width = media_type
        .get("width")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(0);
    let height = media_type
        .get("height")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(0);
    let frame_rate = media_type
        .get("frameRate")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let mut score = 0.0;

    let subtype_matches = preference
        .subtype_fourcc
        .as_ref()
        .map(|expected| {
            subtype
                .as_ref()
                .map(|actual| actual.eq_ignore_ascii_case(expected))
                .unwrap_or(false)
        })
        .unwrap_or(true);
    if !subtype_matches {
        score += 1_000_000.0;
    }

    if let Some(target_width) = preference.width {
        score += (i64::from(width) - i64::from(target_width)).unsigned_abs() as f64 * 10.0;
    }
    if let Some(target_height) = preference.height {
        score += (i64::from(height) - i64::from(target_height)).unsigned_abs() as f64 * 10.0;
    }
    if let Some(target_frame_rate) = preference.frame_rate {
        score += (frame_rate - target_frame_rate).abs() * 100.0;
    }
    if let Some(min_width) = preference.min_width {
        if width < min_width {
            score += f64::from(min_width - width) * 10_000.0;
        }
    }
    if let Some(min_height) = preference.min_height {
        if height < min_height {
            score += f64::from(min_height - height) * 10_000.0;
        }
    }
    if let Some(min_frame_rate) = preference.min_frame_rate {
        if frame_rate < min_frame_rate {
            score += (min_frame_rate - frame_rate) * 100_000.0;
        }
    }

    (
        score,
        json!({
            "subtype": subtype,
            "subtypeMatches": subtype_matches,
            "width": width,
            "height": height,
            "frameRate": frame_rate,
            "widthMatches": preference.width.map(|target| width == target),
            "heightMatches": preference.height.map(|target| height == target),
            "frameRateMatches": preference
                .frame_rate
                .map(|target| (frame_rate - target).abs() < 0.01),
            "minWidthSatisfied": preference.min_width.map(|target| width >= target),
            "minHeightSatisfied": preference.min_height.map(|target| height >= target),
            "minFrameRateSatisfied": preference.min_frame_rate.map(|target| frame_rate >= target)
        }),
    )
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

impl VideoFormatPreference {
    fn to_json(&self) -> Value {
        json!({
            "subtypeFourCc": self.subtype_fourcc.clone(),
            "width": self.width,
            "height": self.height,
            "frameRate": self.frame_rate,
            "minWidth": self.min_width,
            "minHeight": self.min_height,
            "minFrameRate": self.min_frame_rate,
            "maxMediaTypes": self.max_media_types
        })
    }
}

fn video_format_preference_from_params(
    params: &Value,
) -> Result<Option<VideoFormatPreference>, String> {
    let Some(preference) = params.get("videoFormatPreference") else {
        return Ok(None);
    };
    if preference.is_null() {
        return Ok(None);
    }
    if !preference.is_object() {
        return Err("videoFormatPreference must be an object".to_string());
    }
    let subtype_fourcc = preference
        .get("subtypeFourCc")
        .or_else(|| preference.get("subtype"))
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_uppercase())
        .filter(|value| !value.is_empty());
    let width = optional_u32(preference, "width")?;
    let height = optional_u32(preference, "height")?;
    let frame_rate = optional_f64(preference, "frameRate")?;
    let min_width = optional_u32(preference, "minWidth")?;
    let min_height = optional_u32(preference, "minHeight")?;
    let min_frame_rate = optional_f64(preference, "minFrameRate")?;
    let max_media_types = optional_u32(preference, "maxMediaTypes")?
        .unwrap_or(128)
        .clamp(1, 512);

    if subtype_fourcc.is_none()
        && width.is_none()
        && height.is_none()
        && frame_rate.is_none()
        && min_width.is_none()
        && min_height.is_none()
        && min_frame_rate.is_none()
    {
        return Err("videoFormatPreference must include at least one selector".to_string());
    }

    Ok(Some(VideoFormatPreference {
        subtype_fourcc,
        width,
        height,
        frame_rate,
        min_width,
        min_height,
        min_frame_rate,
        max_media_types,
    }))
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

fn optional_f64(params: &Value, field_name: &str) -> Result<Option<f64>, String> {
    let Some(value) = params.get(field_name) else {
        return Ok(None);
    };
    let Some(number) = value.as_f64() else {
        return Err(format!("{field_name} must be a finite number"));
    };
    if !number.is_finite() || number < 0.0 {
        return Err(format!("{field_name} must be a non-negative finite number"));
    }
    Ok(Some(number))
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

fn enumerate_audio_render_devices() -> Result<Vec<Value>, String> {
    with_audio_render_devices(|records| {
        Ok(records
            .iter()
            .map(audio_render_device_record_to_json)
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

fn with_audio_render_devices<T>(
    callback: impl FnOnce(Vec<AudioDeviceRecord>) -> Result<T, String>,
) -> Result<T, String> {
    let enumerator: IMMDeviceEnumerator = unsafe {
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(format_windows_error)?
    };
    let collection = unsafe {
        enumerator
            .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)
            .map_err(format_windows_error)?
    };
    let count = unsafe { collection.GetCount().map_err(format_windows_error)? };
    let mut devices = Vec::new();

    for index in 0..count {
        let device = unsafe { collection.Item(index).map_err(format_windows_error)? };
        let id_ptr = unsafe { device.GetId().map_err(format_windows_error)? };
        let native_id =
            take_cotask_pwstr(id_ptr).unwrap_or_else(|| format!("wasapi-render-{index}"));
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

        let device_id = stable_device_id("wasapi-render", index, &native_id);
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

fn audio_render_device_record_to_json(record: &AudioDeviceRecord) -> Value {
    json!({
        "index": record.index,
        "deviceId": record.device_id,
        "displayName": record.display_name,
        "transport": record.transport,
        "role": "room-speaker",
        "backend": "wasapi",
        "nativeId": record.native_id,
        "dataFlow": "render",
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

fn probe_audio_render_format(params: &Value) -> Result<Value, String> {
    let _com = ComApartment::initialize()?;
    with_audio_render_devices(|records| {
        let selected = select_audio_records_with_label(&records, params, "audio render")?;
        let mut devices = Vec::new();
        for record in selected {
            devices.push(probe_audio_render_record_format(record)?);
        }
        Ok(json!({
            "status": "ok",
            "backend": "wasapi",
            "dataFlow": "render",
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

fn render_audio_silence(params: &Value) -> Result<Value, String> {
    let duration_ms = optional_u32(params, "durationMs")?
        .unwrap_or(500)
        .clamp(100, 5_000);
    let poll_interval_ms = optional_u32(params, "pollIntervalMs")?
        .unwrap_or(10)
        .clamp(1, 100);
    let _com = ComApartment::initialize()?;
    with_audio_render_devices(|records| {
        let selected = select_audio_records_with_label(&records, params, "audio render")?;
        let record = selected
            .first()
            .copied()
            .ok_or_else(|| "No audio render device selected".to_string())?;
        render_audio_silence_for_record(record, duration_ms, poll_interval_ms)
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

fn probe_audio_render_record_format(record: &AudioDeviceRecord) -> Result<Value, String> {
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
            "device": audio_render_device_record_to_json(record),
            "capabilitiesStatus": "mix-format-enumerated",
            "mixFormat": wave_format_to_json(format_ptr)?,
            "devicePeriod": {
                "defaultHns": default_period_hns,
                "minimumHns": minimum_period_hns
            },
            "renderClientStatus": "not-opened"
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

fn render_audio_silence_for_record(
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
        let buffer_frame_capacity =
            unsafe { audio_client.GetBufferSize().map_err(format_windows_error)? };
        let stream_latency_hns = unsafe { audio_client.GetStreamLatency().ok() };
        let render_client: IAudioRenderClient =
            unsafe { audio_client.GetService().map_err(format_windows_error)? };

        let mut poll_count = 0u32;
        let mut write_count = 0u64;
        let mut frames_written = 0u64;
        let mut max_padding_frames = 0u32;
        let mut last_padding_frames = None;

        if buffer_frame_capacity > 0 {
            write_render_silent_frames(&render_client, buffer_frame_capacity)?;
            write_count = write_count.saturating_add(1);
            frames_written = frames_written.saturating_add(u64::from(buffer_frame_capacity));
        }

        unsafe {
            audio_client.Start().map_err(format_windows_error)?;
        }

        let started_at = Instant::now();
        let render_result = (|| {
            while started_at.elapsed() < Duration::from_millis(u64::from(duration_ms)) {
                poll_count = poll_count.saturating_add(1);
                let padding_frames = unsafe {
                    audio_client
                        .GetCurrentPadding()
                        .map_err(format_windows_error)?
                };
                max_padding_frames = max_padding_frames.max(padding_frames);
                last_padding_frames = Some(padding_frames);
                let available_frames = buffer_frame_capacity.saturating_sub(padding_frames);
                if available_frames > 0 {
                    write_render_silent_frames(&render_client, available_frames)?;
                    write_count = write_count.saturating_add(1);
                    frames_written = frames_written.saturating_add(u64::from(available_frames));
                }
                thread::sleep(Duration::from_millis(u64::from(poll_interval_ms)));
            }

            Ok(json!({
                "status": "silence-rendered",
                "backend": "wasapi",
                "device": audio_render_device_record_to_json(record),
                "mixFormat": mix_format,
                "durationMs": duration_ms,
                "elapsedMs": started_at.elapsed().as_millis(),
                "pollIntervalMs": poll_interval_ms,
                "pollCount": poll_count,
                "writeCount": write_count,
                "framesWritten": frames_written,
                "bytesWritten": frames_written.saturating_mul(block_align),
                "bufferFrameCapacity": buffer_frame_capacity,
                "streamLatencyHns": stream_latency_hns,
                "maxPaddingFrames": max_padding_frames,
                "lastPaddingFrames": last_padding_frames,
                "renderClientStatus": "opened-stopped",
                "audibleOutput": "silence",
                "loopbackCaptured": false,
                "aecStatus": "not-run"
            }))
        })();
        let stop_result = unsafe { audio_client.Stop().map_err(format_windows_error) };
        match (render_result, stop_result) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
        }
    })
}

fn write_render_silent_frames(
    render_client: &IAudioRenderClient,
    frame_count: u32,
) -> Result<(), String> {
    if frame_count == 0 {
        return Ok(());
    }
    unsafe {
        let _data_ptr = render_client
            .GetBuffer(frame_count)
            .map_err(format_windows_error)?;
        render_client
            .ReleaseBuffer(frame_count, AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)
            .map_err(format_windows_error)?;
    }
    Ok(())
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
    select_audio_records_with_label(records, params, "audio capture")
}

fn select_audio_records_with_label<'a>(
    records: &'a [AudioDeviceRecord],
    params: &Value,
    label: &str,
) -> Result<Vec<&'a AudioDeviceRecord>, String> {
    if records.is_empty() {
        return Err(format!("No WASAPI {label} devices were found"));
    }
    if params.get("all").and_then(Value::as_bool).unwrap_or(false) {
        return Ok(records.iter().collect());
    }
    if let Some(device_id) = params.get("deviceId").and_then(Value::as_str) {
        return records
            .iter()
            .find(|record| record.device_id == device_id)
            .map(|record| vec![record])
            .ok_or_else(|| format!("WASAPI {label} deviceId not found: {device_id}"));
    }
    if let Some(native_id) = params.get("nativeId").and_then(Value::as_str) {
        return records
            .iter()
            .find(|record| record.native_id == native_id)
            .map(|record| vec![record])
            .ok_or_else(|| format!("WASAPI {label} nativeId not found: {native_id}"));
    }
    let index = optional_u32(params, "index")?.unwrap_or(0);
    records
        .iter()
        .find(|record| record.index == index)
        .map(|record| vec![record])
        .ok_or_else(|| format!("WASAPI {label} index not found: {index}"))
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
        "videoPayloadCopyCount": 0,
        "videoPayloadCopyErrorCount": 0,
        "videoPayloadQueueBytes": 0,
        "videoPayloadTotalCopiedBytes": 0,
        "videoPayloadConsumeCount": 0,
        "videoPayloadConsumedBytes": 0,
        "audioPacketsProduced": 0,
        "audioFramesCaptured": 0,
        "audioBytesCaptured": 0,
        "audioPayloadCopyCount": 0,
        "audioPayloadCopyErrorCount": 0,
        "audioPayloadQueueBytes": 0,
        "audioPayloadTotalCopiedBytes": 0,
        "audioPayloadConsumeCount": 0,
        "audioPayloadConsumedBytes": 0,
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
