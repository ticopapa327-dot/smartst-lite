#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const APP_DIR_NAME: &str = "UST Desktop Client";
const CONFIG_FILE_NAME: &str = "config.json";
const LOG_FILE_NAME: &str = "ust-desktop-client.log";
const CREATE_NO_WINDOW: u32 = 0x08000000;
const DESKTOP_SMOKE_ENV: &str = "UST_DESKTOP_SMOKE";
const DESKTOP_SMOKE_OUTPUT_ENV: &str = "UST_DESKTOP_SMOKE_OUTPUT";
const DESKTOP_SMOKE_REQUIRE_PACKAGED_ENV: &str = "UST_DESKTOP_SMOKE_REQUIRE_PACKAGED";
const DESKTOP_SMOKE_REQUIRE_AV_ENV: &str = "UST_DESKTOP_SMOKE_REQUIRE_AV";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeWorkerReadiness {
    status: String,
    launch_mode: String,
    workspace_root: String,
    manifest_path: String,
    executable_path: String,
    packaged_executable_path: String,
    manifest_exists: bool,
    executable_exists: bool,
    packaged_executable_exists: bool,
    cargo_available: bool,
    cargo_version: Option<String>,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeWorkerDeviceProbe {
    status: String,
    readiness: NativeWorkerReadiness,
    devices: Value,
    message: String,
}

struct NativeWorkerProcess {
    child: Child,
    stdin: ChildStdin,
    line_receiver: mpsc::Receiver<String>,
}

impl Drop for NativeWorkerProcess {
    fn drop(&mut self) {
        let _ = write_native_worker_request(&mut self.stdin, "shutdown", "shutdown", Value::Null);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

static NATIVE_WORKER_SESSION: Lazy<Mutex<Option<NativeWorkerProcess>>> =
    Lazy::new(|| Mutex::new(None));

#[tauri::command]
fn get_default_paths() -> Result<Value, String> {
    Ok(json!({
        "configPath": config_path()?.to_string_lossy(),
        "logDirectory": log_dir()?.to_string_lossy()
    }))
}

#[tauri::command]
fn load_config() -> Result<Option<Value>, String> {
    let path = config_path()?;

    if !path.exists() {
        return Ok(None);
    }

    let text = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read config file: {error}"))?;
    let value = serde_json::from_str::<Value>(&text)
        .map_err(|error| format!("Failed to parse config file: {error}"))?;

    Ok(Some(value))
}

#[tauri::command]
fn save_config(config: Value) -> Result<(), String> {
    let path = config_path()?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create config directory: {error}"))?;
    }

    let text = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("Failed to serialize config: {error}"))?;
    fs::write(&path, text).map_err(|error| format!("Failed to write config file: {error}"))?;

    Ok(())
}

#[tauri::command]
fn append_log(entry: Value) -> Result<(), String> {
    let directory = entry
        .get("logDirectory")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or(log_dir()?);

    fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create log directory: {error}"))?;

    let path = directory.join(LOG_FILE_NAME);
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("Failed to open log file: {error}"))?;

    let line = serde_json::to_string(&entry)
        .map_err(|error| format!("Failed to serialize log entry: {error}"))?;
    writeln!(file, "{line}").map_err(|error| format!("Failed to write log entry: {error}"))?;

    Ok(())
}

#[tauri::command]
fn get_native_worker_readiness(app: tauri::AppHandle) -> Result<NativeWorkerReadiness, String> {
    native_worker_readiness(Some(&app))
}

fn native_worker_readiness(
    app: Option<&tauri::AppHandle>,
) -> Result<NativeWorkerReadiness, String> {
    let workspace_root = workspace_root_dir().ok();
    let manifest_path = workspace_root
        .as_ref()
        .map(|root| root.join("native-worker").join("Cargo.toml"));
    let workspace_executable_path = workspace_root
        .as_ref()
        .map(|root| native_worker_executable_path(root));
    let packaged_executable_path = packaged_native_worker_executable_path(app);
    let selected_executable_path = packaged_executable_path
        .as_ref()
        .or(workspace_executable_path.as_ref());
    let manifest_exists = manifest_path.as_ref().is_some_and(|path| path.is_file());
    let executable_exists = selected_executable_path.is_some_and(|path| path.is_file());
    let packaged_executable_exists = packaged_executable_path
        .as_ref()
        .is_some_and(|path| path.is_file());
    let cargo_version = command_version("cargo", "--version");
    let cargo_available = cargo_version.is_some();
    let (status, launch_mode, message) = if packaged_executable_exists {
        (
            "ready",
            "packaged",
            "Native Worker packaged binary is available.",
        )
    } else if manifest_exists && executable_exists {
        (
            "ready",
            "workspace-binary",
            "Native Worker workspace debug binary is available.",
        )
    } else if manifest_exists && cargo_available {
        (
            "ready",
            "workspace-source",
            "Native Worker source is available and Cargo can build it.",
        )
    } else if manifest_exists {
        (
            "source-only",
            "workspace-source-only",
            "Native Worker source exists, but Cargo/debug binary is unavailable.",
        )
    } else {
        (
            "missing",
            "missing",
            "Native Worker packaged binary and workspace source are both unavailable.",
        )
    };

    Ok(NativeWorkerReadiness {
        status: status.to_string(),
        launch_mode: launch_mode.to_string(),
        workspace_root: workspace_root
            .as_ref()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        manifest_path: manifest_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        executable_path: selected_executable_path
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        packaged_executable_path: packaged_executable_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        manifest_exists,
        executable_exists,
        packaged_executable_exists,
        cargo_available,
        cargo_version,
        message: message.to_string(),
    })
}

#[tauri::command]
fn probe_native_worker_devices(app: tauri::AppHandle) -> Result<NativeWorkerDeviceProbe, String> {
    let readiness = native_worker_readiness(Some(&app))?;
    if readiness.status != "ready" {
        return Ok(NativeWorkerDeviceProbe {
            status: "unavailable".to_string(),
            readiness,
            devices: Value::Null,
            message: "Native Worker is not ready for device probing.".to_string(),
        });
    }

    let mut command = native_worker_launch_command(Some(&app))?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_no_window(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start Native Worker: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Native Worker stdout was not captured.".to_string())?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Native Worker stdin was not captured.".to_string())?;
    let (line_sender, line_receiver) = mpsc::channel::<String>();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if line_sender.send(line).is_err() {
                break;
            }
        }
    });

    let result = (|| {
        wait_native_worker_ready(&line_receiver, Duration::from_secs(30))?;
        write_native_worker_request(&mut stdin, "list-devices", "listDevices", Value::Null)?;
        let devices =
            wait_native_worker_response(&line_receiver, "list-devices", Duration::from_secs(30))?;
        let _ = write_native_worker_request(&mut stdin, "shutdown", "shutdown", Value::Null);
        Ok::<Value, String>(devices)
    })();

    let _ = child.kill();
    let _ = child.wait();

    result.map(|devices| NativeWorkerDeviceProbe {
        status: "ok".to_string(),
        readiness,
        devices,
        message: "Native Worker listDevices completed.".to_string(),
    })
}

#[tauri::command]
fn start_native_worker_session(
    app: tauri::AppHandle,
    params: Option<Value>,
) -> Result<Value, String> {
    let mut session = NATIVE_WORKER_SESSION
        .lock()
        .map_err(|_| "Native Worker session lock is poisoned.".to_string())?;
    if session.is_none() {
        *session = Some(spawn_native_worker_process(Some(&app))?);
    }
    let worker = session
        .as_mut()
        .ok_or_else(|| "Native Worker session was not created.".to_string())?;
    let start_params = params.unwrap_or_else(default_native_worker_start_params);
    let request_id = native_worker_request_id("start");
    write_native_worker_request(&mut worker.stdin, &request_id, "start", start_params)?;
    let response =
        wait_native_worker_response(&worker.line_receiver, &request_id, Duration::from_secs(30));
    if response.is_err() {
        if let Some(mut failed_worker) = session.take() {
            let _ = failed_worker.child.kill();
            let _ = failed_worker.child.wait();
        }
    }
    response
}

#[tauri::command]
fn get_native_worker_session_status() -> Result<Value, String> {
    let mut session = NATIVE_WORKER_SESSION
        .lock()
        .map_err(|_| "Native Worker session lock is poisoned.".to_string())?;
    let Some(worker) = session.as_mut() else {
        return Ok(json!({
            "state": "idle",
            "captureSession": { "state": "idle" },
            "channels": [],
            "stats": { "realMediaSession": false }
        }));
    };
    let request_id = native_worker_request_id("status");
    write_native_worker_request(&mut worker.stdin, &request_id, "status", Value::Null)?;
    wait_native_worker_response(&worker.line_receiver, &request_id, Duration::from_secs(10))
}

#[tauri::command]
fn consume_native_worker_video_payload_queue(params: Option<Value>) -> Result<Value, String> {
    let mut session = NATIVE_WORKER_SESSION
        .lock()
        .map_err(|_| "Native Worker session lock is poisoned.".to_string())?;
    let Some(worker) = session.as_mut() else {
        return Err("Native Worker session is not running.".to_string());
    };
    let consume_params = params.unwrap_or_else(default_native_worker_payload_consume_params);
    let request_id = native_worker_request_id("consume-video-payload");
    write_native_worker_request(
        &mut worker.stdin,
        &request_id,
        "consumeVideoPayloadQueue",
        consume_params,
    )?;
    wait_native_worker_response(&worker.line_receiver, &request_id, Duration::from_secs(10))
}

#[tauri::command]
fn consume_native_worker_audio_payload_queue(params: Option<Value>) -> Result<Value, String> {
    let mut session = NATIVE_WORKER_SESSION
        .lock()
        .map_err(|_| "Native Worker session lock is poisoned.".to_string())?;
    let Some(worker) = session.as_mut() else {
        return Err("Native Worker session is not running.".to_string());
    };
    let consume_params = params.unwrap_or_else(default_native_worker_audio_payload_consume_params);
    let request_id = native_worker_request_id("consume-audio-payload");
    write_native_worker_request(
        &mut worker.stdin,
        &request_id,
        "consumeAudioPayloadQueue",
        consume_params,
    )?;
    wait_native_worker_response(&worker.line_receiver, &request_id, Duration::from_secs(10))
}

#[tauri::command]
fn stop_native_worker_session() -> Result<Value, String> {
    let mut session = NATIVE_WORKER_SESSION
        .lock()
        .map_err(|_| "Native Worker session lock is poisoned.".to_string())?;
    let Some(mut worker) = session.take() else {
        return Ok(json!({
            "state": "idle",
            "captureSession": { "state": "idle" },
            "channels": [],
            "stats": { "realMediaSession": false }
        }));
    };
    let request_id = native_worker_request_id("stop");
    let stop_result = write_native_worker_request(
        &mut worker.stdin,
        &request_id,
        "stop",
        Value::Null,
    )
    .and_then(|_| {
        wait_native_worker_response(&worker.line_receiver, &request_id, Duration::from_secs(30))
    });
    let _ = write_native_worker_request(&mut worker.stdin, "shutdown", "shutdown", Value::Null);
    let _ = worker.child.kill();
    let _ = worker.child.wait();
    stop_result
}

fn apply_no_window(command: &mut Command) {
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

fn command_version(program: &str, version_arg: &str) -> Option<String> {
    let mut command = Command::new(program);
    command
        .arg(version_arg)
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    apply_no_window(&mut command);

    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

fn workspace_root_dir() -> Result<PathBuf, String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut candidates = Vec::new();
    if let Some(parent) = manifest_dir.parent() {
        candidates.push(parent.to_path_buf());
    }
    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir.clone());
        if let Some(parent) = current_dir.parent() {
            candidates.push(parent.to_path_buf());
        }
    }

    candidates
        .into_iter()
        .find(|candidate| candidate.join("native-worker").join("Cargo.toml").is_file())
        .ok_or_else(|| "Native Worker workspace root not found.".to_string())
}

fn native_worker_executable_name() -> &'static str {
    if cfg!(windows) {
        "ust-native-worker.exe"
    } else {
        "ust-native-worker"
    }
}

fn native_worker_executable_path(workspace_root: &Path) -> PathBuf {
    workspace_root
        .join("native-worker")
        .join("target")
        .join("debug")
        .join(native_worker_executable_name())
}

fn packaged_native_worker_candidate_paths(app: Option<&tauri::AppHandle>) -> Vec<PathBuf> {
    let executable_name = native_worker_executable_name();
    let mut candidates = Vec::new();

    if let Some(app) = app {
        if let Ok(resource_dir) = app.path().resource_dir() {
            candidates.push(resource_dir.join("bin").join(executable_name));
            candidates.push(resource_dir.join(executable_name));
        }
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            candidates.push(exe_dir.join("bin").join(executable_name));
            candidates.push(exe_dir.join("resources").join("bin").join(executable_name));
            candidates.push(exe_dir.join(executable_name));
        }
    }

    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

fn packaged_native_worker_executable_path(app: Option<&tauri::AppHandle>) -> Option<PathBuf> {
    packaged_native_worker_candidate_paths(app)
        .into_iter()
        .find(|path| path.is_file())
}

fn native_worker_workspace_launch_command(workspace_root: &Path) -> Result<Command, String> {
    let executable_path = native_worker_executable_path(workspace_root);
    if executable_path.is_file() {
        let mut command = Command::new(executable_path);
        command.current_dir(workspace_root);
        return Ok(command);
    }

    if command_version("cargo", "--version").is_none() {
        return Err("Cargo is unavailable and Native Worker debug binary is missing.".to_string());
    }

    let mut command = Command::new("cargo");
    command
        .arg("run")
        .arg("--quiet")
        .arg("--manifest-path")
        .arg(workspace_root.join("native-worker").join("Cargo.toml"))
        .current_dir(workspace_root);
    Ok(command)
}

fn native_worker_launch_command(app: Option<&tauri::AppHandle>) -> Result<Command, String> {
    if let Some(executable_path) = packaged_native_worker_executable_path(app) {
        let mut command = Command::new(&executable_path);
        if let Some(parent) = executable_path.parent() {
            command.current_dir(parent);
        }
        return Ok(command);
    }

    let workspace_root = workspace_root_dir()?;
    native_worker_workspace_launch_command(&workspace_root)
}

fn spawn_native_worker_process(
    app: Option<&tauri::AppHandle>,
) -> Result<NativeWorkerProcess, String> {
    let mut command = native_worker_launch_command(app)?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_no_window(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start Native Worker: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Native Worker stdout was not captured.".to_string())?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Native Worker stdin was not captured.".to_string())?;
    let (line_sender, line_receiver) = mpsc::channel::<String>();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if line_sender.send(line).is_err() {
                break;
            }
        }
    });
    wait_native_worker_ready(&line_receiver, Duration::from_secs(30))?;

    Ok(NativeWorkerProcess {
        child,
        stdin,
        line_receiver,
    })
}

fn default_native_worker_start_params() -> Value {
    json!({
        "channels": ["field-camera", "endoscope"],
        "videoMediaTypeIndex": 0,
        "audioIndex": 0,
        "startVideoThread": true,
        "startAudioThread": true,
        "videoFrameQueueCapacity": 3,
        "audioPayloadQueueCapacity": 50
    })
}

fn default_native_worker_payload_consume_params() -> Value {
    json!({
        "maxFrames": 2
    })
}

fn default_native_worker_audio_payload_consume_params() -> Value {
    json!({
        "maxPackets": 5
    })
}

fn desktop_smoke_enabled() -> bool {
    env_truthy(DESKTOP_SMOKE_ENV)
}

fn env_truthy(name: &str) -> bool {
    std::env::var(name)
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn desktop_smoke_output_path() -> PathBuf {
    std::env::var_os(DESKTOP_SMOKE_OUTPUT_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("ust-desktop-smoke-result.json"))
}

fn run_desktop_smoke(app: &tauri::AppHandle) -> Result<Value, String> {
    let started_at = unix_timestamp_ms();
    let require_packaged = env_truthy(DESKTOP_SMOKE_REQUIRE_PACKAGED_ENV);
    let require_av = env_truthy(DESKTOP_SMOKE_REQUIRE_AV_ENV);
    let readiness = native_worker_readiness(Some(app))?;

    if readiness.status != "ready" {
        return Err(format!(
            "Native Worker is not ready for desktop smoke: {}",
            readiness.message
        ));
    }
    if require_packaged && readiness.launch_mode != "packaged" {
        return Err(format!(
            "Desktop smoke requires packaged Native Worker, got launchMode={}",
            readiness.launch_mode
        ));
    }

    let mut worker = spawn_native_worker_process(Some(app))?;
    let devices_id = native_worker_request_id("desktop-smoke-devices");
    write_native_worker_request(&mut worker.stdin, &devices_id, "listDevices", Value::Null)?;
    let devices =
        wait_native_worker_response(&worker.line_receiver, &devices_id, Duration::from_secs(30))?;

    let start_id = native_worker_request_id("desktop-smoke-start");
    write_native_worker_request(
        &mut worker.stdin,
        &start_id,
        "start",
        default_native_worker_start_params(),
    )?;
    let started =
        wait_native_worker_response(&worker.line_receiver, &start_id, Duration::from_secs(30))?;
    if started.get("state").and_then(Value::as_str) != Some("running") {
        return Err("Desktop smoke Native Worker start did not return running.".to_string());
    }

    thread::sleep(Duration::from_millis(1500));

    let bound_video_channels = value_at_u64(&started, &["captureSession", "boundVideoChannels"]);
    let bound_audio_endpoints = value_at_u64(&started, &["captureSession", "boundAudioEndpoints"]);
    if require_av && bound_video_channels == 0 {
        return Err("Desktop smoke requires at least one bound video channel.".to_string());
    }
    if require_av && bound_audio_endpoints == 0 {
        return Err("Desktop smoke requires at least one bound audio endpoint.".to_string());
    }

    let video_consume = if bound_video_channels > 0 {
        let video_id = native_worker_request_id("desktop-smoke-drain-video");
        write_native_worker_request(
            &mut worker.stdin,
            &video_id,
            "consumeVideoPayloadQueue",
            json!({
                "channelId": "field-camera",
                "maxFrames": 1
            }),
        )?;
        let value =
            wait_native_worker_response(&worker.line_receiver, &video_id, Duration::from_secs(10))?;
        if require_av && value_at_u64(&value, &["consumedFrames"]) == 0 {
            return Err("Desktop smoke video drain consumed zero frames.".to_string());
        }
        value
    } else {
        Value::Null
    };

    let audio_consume = if bound_audio_endpoints > 0 {
        let audio_id = native_worker_request_id("desktop-smoke-drain-audio");
        write_native_worker_request(
            &mut worker.stdin,
            &audio_id,
            "consumeAudioPayloadQueue",
            default_native_worker_audio_payload_consume_params(),
        )?;
        let value =
            wait_native_worker_response(&worker.line_receiver, &audio_id, Duration::from_secs(10))?;
        if require_av && value_at_u64(&value, &["consumedPackets"]) == 0 {
            return Err("Desktop smoke audio drain consumed zero packets.".to_string());
        }
        value
    } else {
        Value::Null
    };

    let status_id = native_worker_request_id("desktop-smoke-status");
    write_native_worker_request(&mut worker.stdin, &status_id, "status", Value::Null)?;
    let status =
        wait_native_worker_response(&worker.line_receiver, &status_id, Duration::from_secs(10))?;

    let stop_id = native_worker_request_id("desktop-smoke-stop");
    write_native_worker_request(&mut worker.stdin, &stop_id, "stop", Value::Null)?;
    let stopped =
        wait_native_worker_response(&worker.line_receiver, &stop_id, Duration::from_secs(30))?;
    let _ = write_native_worker_request(&mut worker.stdin, "shutdown", "shutdown", Value::Null);
    let _ = worker.child.kill();
    let _ = worker.child.wait();

    if stopped.get("state").and_then(Value::as_str) != Some("idle") {
        return Err("Desktop smoke Native Worker stop did not return idle.".to_string());
    }

    let finished_at = unix_timestamp_ms();
    Ok(json!({
        "status": "passed",
        "schemaVersion": "ust.desktop-smoke.v0.1",
        "startedAtUnixMs": started_at,
        "finishedAtUnixMs": finished_at,
        "elapsedMs": finished_at.saturating_sub(started_at),
        "requirePackaged": require_packaged,
        "requireAv": require_av,
        "readiness": readiness,
        "devices": {
            "source": devices.get("source").cloned().unwrap_or(Value::Null),
            "videoCount": devices.get("video").and_then(Value::as_array).map(|items| items.len()).unwrap_or(0),
            "audioCount": devices.get("audio").and_then(Value::as_array).map(|items| items.len()).unwrap_or(0),
            "audioRenderCount": devices.get("audioRender").and_then(Value::as_array).map(|items| items.len()).unwrap_or(0),
            "diagnostics": devices.get("diagnostics").cloned().unwrap_or(Value::Null)
        },
        "session": {
            "startedState": started.get("state").cloned().unwrap_or(Value::Null),
            "stoppedState": stopped.get("state").cloned().unwrap_or(Value::Null),
            "boundVideoChannels": bound_video_channels,
            "boundAudioEndpoints": bound_audio_endpoints,
            "videoConsumedFrames": value_at_u64(&video_consume, &["consumedFrames"]),
            "videoConsumedBytes": value_at_u64(&video_consume, &["consumedBytes"]),
            "audioConsumedPackets": value_at_u64(&audio_consume, &["consumedPackets"]),
            "audioConsumedBytes": value_at_u64(&audio_consume, &["consumedBytes"]),
            "statusState": status.get("state").cloned().unwrap_or(Value::Null),
            "captureState": status.get("captureSession").and_then(|value| value.get("state")).cloned().unwrap_or(Value::Null)
        }
    }))
}

fn write_desktop_smoke_output(path: &Path, result: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create desktop smoke output directory {}: {error}",
                parent.to_string_lossy()
            )
        })?;
    }
    let text = serde_json::to_string_pretty(result)
        .map_err(|error| format!("Failed to serialize desktop smoke result: {error}"))?;
    fs::write(path, text).map_err(|error| {
        format!(
            "Failed to write desktop smoke output {}: {error}",
            path.to_string_lossy()
        )
    })
}

fn value_at_u64(value: &Value, path: &[&str]) -> u64 {
    let mut current = value;
    for key in path {
        let Some(next) = current.get(*key) else {
            return 0;
        };
        current = next;
    }
    current.as_u64().unwrap_or(0)
}

fn unix_timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn native_worker_request_id(prefix: &str) -> String {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("{prefix}-{suffix}")
}

fn wait_native_worker_ready(
    line_receiver: &mpsc::Receiver<String>,
    timeout: Duration,
) -> Result<(), String> {
    let started_at = Instant::now();
    while started_at.elapsed() < timeout {
        let remaining = timeout.saturating_sub(started_at.elapsed());
        let wait_for = remaining.min(Duration::from_millis(250));
        let Ok(line) = line_receiver.recv_timeout(wait_for) else {
            continue;
        };
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if message.get("type").and_then(Value::as_str) == Some("event")
            && message
                .get("event")
                .and_then(|event| event.get("category"))
                .and_then(Value::as_str)
                == Some("worker")
            && message
                .get("event")
                .and_then(|event| event.get("name"))
                .and_then(Value::as_str)
                == Some("ready")
        {
            return Ok(());
        }
    }

    Err("Native Worker ready event timed out.".to_string())
}

fn write_native_worker_request(
    stdin: &mut std::process::ChildStdin,
    id: &str,
    method: &str,
    params: Value,
) -> Result<(), String> {
    let payload = if params.is_null() {
        json!({ "id": id, "method": method })
    } else {
        json!({ "id": id, "method": method, "params": params })
    };
    writeln!(stdin, "{payload}")
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("Failed to write Native Worker request: {error}"))
}

fn wait_native_worker_response(
    line_receiver: &mpsc::Receiver<String>,
    expected_id: &str,
    timeout: Duration,
) -> Result<Value, String> {
    let started_at = Instant::now();
    while started_at.elapsed() < timeout {
        let remaining = timeout.saturating_sub(started_at.elapsed());
        let wait_for = remaining.min(Duration::from_millis(250));
        let Ok(line) = line_receiver.recv_timeout(wait_for) else {
            continue;
        };
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if message.get("type").and_then(Value::as_str) != Some("response")
            || message.get("id").and_then(Value::as_str) != Some(expected_id)
        {
            continue;
        }
        if message.get("ok").and_then(Value::as_bool) == Some(true) {
            return Ok(message.get("result").cloned().unwrap_or(Value::Null));
        }
        let error_message = message
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("Native Worker command failed.");
        return Err(error_message.to_string());
    }

    Err(format!("Native Worker response timed out: {expected_id}"))
}

fn config_path() -> Result<PathBuf, String> {
    Ok(app_base_dir()?.join(CONFIG_FILE_NAME))
}

fn log_dir() -> Result<PathBuf, String> {
    Ok(app_base_dir()?.join("logs"))
}

fn app_base_dir() -> Result<PathBuf, String> {
    let base = std::env::var_os("APPDATA")
        .or_else(|| std::env::var_os("LOCALAPPDATA"))
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir().map_err(|error| error.to_string())?);

    Ok(base.join(APP_DIR_NAME))
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            if desktop_smoke_enabled() {
                let app_handle = app.handle().clone();
                thread::spawn(move || {
                    let output_path = desktop_smoke_output_path();
                    let smoke_result = match run_desktop_smoke(&app_handle) {
                        Ok(result) => result,
                        Err(error) => json!({
                            "status": "failed",
                            "schemaVersion": "ust.desktop-smoke.v0.1",
                            "error": error
                        }),
                    };
                    let exit_code =
                        if smoke_result.get("status").and_then(Value::as_str) == Some("passed") {
                            0
                        } else {
                            1
                        };
                    if let Err(error) = write_desktop_smoke_output(&output_path, &smoke_result) {
                        let fallback = json!({
                            "status": "failed",
                            "schemaVersion": "ust.desktop-smoke.v0.1",
                            "error": error
                        });
                        let _ = write_desktop_smoke_output(&output_path, &fallback);
                        app_handle.exit(1);
                        return;
                    }
                    app_handle.exit(exit_code);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_default_paths,
            load_config,
            save_config,
            append_log,
            get_native_worker_readiness,
            probe_native_worker_devices,
            start_native_worker_session,
            get_native_worker_session_status,
            consume_native_worker_video_payload_queue,
            consume_native_worker_audio_payload_queue,
            stop_native_worker_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running UST Desktop Client");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_native_worker_start_params_keep_media_payload_native() {
        let params = default_native_worker_start_params();

        assert_eq!(params["channels"][0], json!("field-camera"));
        assert_eq!(params["channels"][1], json!("endoscope"));
        assert_eq!(params["startVideoThread"], json!(true));
        assert_eq!(params["startAudioThread"], json!(true));
        assert_eq!(params["videoFrameQueueCapacity"], json!(3));
        assert_eq!(params["audioPayloadQueueCapacity"], json!(50));
    }

    #[test]
    fn default_native_worker_payload_consume_params_keep_payload_native() {
        let params = default_native_worker_payload_consume_params();

        assert_eq!(params["maxFrames"], json!(2));
    }

    #[test]
    fn default_native_worker_audio_payload_consume_params_keep_payload_native() {
        let params = default_native_worker_audio_payload_consume_params();

        assert_eq!(params["maxPackets"], json!(5));
    }

    #[test]
    fn workspace_root_resolves_native_worker_manifest() {
        let workspace_root = workspace_root_dir().expect("workspace root resolves");

        assert!(workspace_root
            .join("native-worker")
            .join("Cargo.toml")
            .is_file());
    }

    #[test]
    fn native_worker_executable_path_uses_debug_binary_name() {
        let workspace_root = PathBuf::from("D:/workspace");
        let executable_path = native_worker_executable_path(&workspace_root);
        let file_name = executable_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();

        if cfg!(windows) {
            assert_eq!(file_name, "ust-native-worker.exe");
        } else {
            assert_eq!(file_name, "ust-native-worker");
        }

        assert!(executable_path.to_string_lossy().contains("native-worker"));
        assert!(executable_path.to_string_lossy().contains("debug"));
    }

    #[test]
    fn packaged_native_worker_candidates_include_local_fallbacks() {
        let candidates = packaged_native_worker_candidate_paths(None);

        assert!(candidates.iter().any(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value == native_worker_executable_name())
        }));
        assert!(candidates
            .iter()
            .any(|path| path.to_string_lossy().contains("bin")));
    }
}
