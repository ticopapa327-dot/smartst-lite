use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::ptr;
use std::thread;
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
    MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED,
    MF_SOURCE_READERF_ENDOFSTREAM, MF_SOURCE_READERF_ERROR,
    MF_SOURCE_READERF_NATIVEMEDIATYPECHANGED, MF_SOURCE_READER_FIRST_VIDEO_STREAM, MF_VERSION,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED, STGM_READ,
};

const DEFAULT_CHANNELS: [&str; 4] = ["panorama", "field-camera", "endoscope", "aux-device"];
const WAVE_FORMAT_PCM_TAG: u16 = 1;
const WAVE_FORMAT_IEEE_FLOAT_TAG: u16 = 3;
const WAVE_FORMAT_EXTENSIBLE_TAG: u16 = 0xfffe;

#[derive(Debug, Clone)]
struct WorkerState {
    process_id: String,
    worker_version: String,
    state: String,
    started_at: Option<String>,
    stopped_at: Option<String>,
    channels: Vec<Value>,
    recording: Value,
    livekit: Value,
    stats: Value,
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

impl WorkerState {
    fn new() -> Self {
        Self {
            process_id: format!("native-worker-{}", std::process::id()),
            worker_version: "native-poc-0.1".to_string(),
            state: "idle".to_string(),
            started_at: None,
            stopped_at: None,
            channels: Vec::new(),
            recording: idle_recording(),
            livekit: idle_livekit(),
            stats: json!({
                "uptimeMs": 0,
                "framesProduced": 0,
                "audioPacketsProduced": 0,
                "syntheticFramesProduced": 0
            }),
            last_error: None,
        }
    }

    fn snapshot(&self) -> Value {
        json!({
            "processId": self.process_id,
            "workerVersion": self.worker_version,
            "state": self.state,
            "startedAt": self.started_at,
            "stoppedAt": self.stopped_at,
            "channels": self.channels,
            "recording": self.recording,
            "livekit": self.livekit,
            "stats": self.stats,
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
        "shutdown" => Ok((json!({ "shuttingDown": true }), true)),
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

    state.state = "running".to_string();
    state.started_at = Some(now_iso_like());
    state.stopped_at = None;
    state.channels = requested_channels
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
                "priority": index + 1
            })
        })
        .collect();
    state.recording = idle_recording();
    state.livekit = idle_livekit();
    state.stats = json!({
        "uptimeMs": 0,
        "framesProduced": 0,
        "audioPacketsProduced": 0,
        "syntheticFramesProduced": 0
    });

    emit_event("device", "snapshot", enumerate_native_devices());
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

    state.state = "idle".to_string();
    state.stopped_at = Some(now_iso_like());
    state.channels.clear();
    state.recording = idle_recording();
    state.livekit = idle_livekit();
    emit_event("worker", "stopped", state.snapshot());
    state.snapshot()
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
