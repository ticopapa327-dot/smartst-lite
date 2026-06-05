use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_CHANNELS: [&str; 4] = ["panorama", "field-camera", "endoscope", "aux-device"];

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
            let devices = mock_devices();
            emit_event("device", "snapshot", devices.clone());
            Ok((devices, false))
        }
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
        .unwrap_or_else(|| DEFAULT_CHANNELS.iter().map(|channel| channel.to_string()).collect());

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

    emit_event("device", "snapshot", mock_devices());
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
        "video": [
            {
                "deviceId": "mock-native-video-panorama",
                "displayName": "Mock Native USB Capture - Panorama",
                "transport": "usb",
                "role": "panorama",
                "capabilities": [{ "width": 1920, "height": 1080, "frameRate": 30 }]
            },
            {
                "deviceId": "mock-native-video-field",
                "displayName": "Mock Native USB Capture - Surgical Field",
                "transport": "usb",
                "role": "field",
                "capabilities": [{ "width": 1920, "height": 1080, "frameRate": 30 }]
            },
            {
                "deviceId": "mock-native-video-endoscope",
                "displayName": "Mock Native USB Capture - Endoscope",
                "transport": "usb",
                "role": "endoscope",
                "capabilities": [{ "width": 1920, "height": 1080, "frameRate": 30 }]
            },
            {
                "deviceId": "mock-native-video-device",
                "displayName": "Mock Native USB Capture - Medical Device",
                "transport": "usb",
                "role": "device",
                "capabilities": [{ "width": 1920, "height": 1080, "frameRate": 30 }]
            }
        ],
        "audio": [
            {
                "deviceId": "mock-native-audio-room",
                "displayName": "Mock Native USB Omnidirectional Microphone",
                "transport": "usb",
                "role": "room-microphone",
                "capabilities": [{ "sampleRate": 48000, "channels": 2 }]
            }
        ]
    })
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
