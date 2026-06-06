#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use get_if_addrs::{get_if_addrs, IfAddr};
use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Cursor, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, ToSocketAddrs, UdpSocket},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tiny_http::{Header, Method, Response, Server, StatusCode};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const APP_DIR_NAME: &str = "SmartST Lite";
const CONFIG_FILE_NAME: &str = "config.json";
const LOG_FILE_NAME: &str = "smartst-lite.log";
const WS_DISCOVERY_ADDRESS: &str = "239.255.255.250:3702";
const WS_DISCOVERY_PORT: u16 = 3702;
const PREVIEW_HTTP_PORT_START: u16 = 38180;
const PREVIEW_HTTP_PORT_END: u16 = 38199;
const CREATE_NO_WINDOW: u32 = 0x08000000;
const DESKTOP_SMOKE_ENV: &str = "SMARTST_DESKTOP_SMOKE";
const DESKTOP_SMOKE_OUTPUT_ENV: &str = "SMARTST_DESKTOP_SMOKE_OUTPUT";
const DESKTOP_SMOKE_REQUIRE_PACKAGED_ENV: &str = "SMARTST_DESKTOP_SMOKE_REQUIRE_PACKAGED";
const DESKTOP_SMOKE_REQUIRE_AV_ENV: &str = "SMARTST_DESKTOP_SMOKE_REQUIRE_AV";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveredOnvifCamera {
    id: String,
    name: String,
    ip_address: String,
    onvif_port: String,
    xaddr: String,
    scopes: Vec<String>,
    source_address: String,
    discovered_at: String,
}

#[derive(Debug, Clone)]
struct DiscoveryInterface {
    bind_ip: Option<Ipv4Addr>,
    broadcast_ip: Option<Ipv4Addr>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RtspPreviewSession {
    playback_url: String,
    log_path: String,
    message: String,
}

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RtspStreamResolution {
    rtsp_url: String,
    profile_token: String,
    profile_name: String,
    media_xaddr: String,
    message: String,
}

#[derive(Debug, Clone)]
struct OnvifProfile {
    token: String,
    name: String,
}

#[derive(Debug, Clone)]
struct HttpTarget {
    host: String,
    port: u16,
    path: String,
}

struct PreviewProcess {
    child: Child,
    directory: PathBuf,
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

#[derive(Default)]
struct PreviewRuntime {
    server_port: Option<u16>,
    sessions: HashMap<String, PreviewProcess>,
}

static PREVIEW_RUNTIME: Lazy<Mutex<PreviewRuntime>> =
    Lazy::new(|| Mutex::new(PreviewRuntime::default()));
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

#[tauri::command]
fn resolve_rtsp_stream_uri(
    ip_address: String,
    onvif_port: String,
    username: String,
    password: String,
) -> Result<RtspStreamResolution, String> {
    let ip_address = ip_address.trim();
    if ip_address.is_empty() {
        return Err("请输入摄像机 IP 地址。".to_string());
    }

    let port = onvif_port
        .trim()
        .parse::<u16>()
        .map_err(|_| "ONVIF 端口必须是数字。".to_string())?;
    let username = username.trim().to_string();
    let password = password.to_string();
    let device_xaddr = format!("http://{ip_address}:{port}/onvif/device_service");

    let capabilities = onvif_post(
        &device_xaddr,
        ip_address,
        &soap_envelope(
            r#"<tds:GetCapabilities>
  <tds:Category>Media</tds:Category>
</tds:GetCapabilities>"#,
            &username,
            &password,
        )?,
    )?;
    let media_xaddr = extract_xml_values(&capabilities, "XAddr")
        .into_iter()
        .find(|value| value.to_ascii_lowercase().contains("/onvif"))
        .unwrap_or_else(|| format!("http://{ip_address}:{port}/onvif/Media"));

    let profiles_response = onvif_post(
        &media_xaddr,
        ip_address,
        &soap_envelope("<trt:GetProfiles />", &username, &password)?,
    )?;
    let profiles = extract_onvif_profiles(&profiles_response);
    let profile = choose_onvif_profile(&profiles).ok_or_else(|| {
        "ONVIF 已连接，但未返回可用的视频 Profile；请检查摄像机 ONVIF/媒体服务设置。".to_string()
    })?;

    let stream_response = onvif_post(
        &media_xaddr,
        ip_address,
        &soap_envelope(
            &format!(
                r#"<trt:GetStreamUri>
  <trt:StreamSetup>
    <tt:Stream>RTP-Unicast</tt:Stream>
    <tt:Transport>
      <tt:Protocol>RTSP</tt:Protocol>
    </tt:Transport>
  </trt:StreamSetup>
  <trt:ProfileToken>{}</trt:ProfileToken>
</trt:GetStreamUri>"#,
                xml_escape(&profile.token)
            ),
            &username,
            &password,
        )?,
    )?;
    let raw_uri = extract_xml_values(&stream_response, "Uri")
        .into_iter()
        .find(|value| value.starts_with("rtsp://") || value.starts_with("rtsps://"))
        .ok_or_else(|| "ONVIF 未返回 RTSP StreamUri。".to_string())?;
    let rtsp_url = rtsp_url_with_credentials(&raw_uri, &username, &password);
    let message = if rtsp_url == raw_uri {
        "已通过 ONVIF GetStreamUri 获取 RTSP 地址。".to_string()
    } else {
        "已通过 ONVIF GetStreamUri 获取 RTSP 地址，并补入用户名密码用于 FFmpeg 预览。".to_string()
    };

    Ok(RtspStreamResolution {
        rtsp_url,
        profile_token: profile.token,
        profile_name: profile.name,
        media_xaddr,
        message,
    })
}

#[tauri::command]
fn start_rtsp_preview(camera_id: String, rtsp_url: String) -> Result<RtspPreviewSession, String> {
    let rtsp_url = rtsp_url.trim().to_string();
    if !(rtsp_url.starts_with("rtsp://") || rtsp_url.starts_with("rtsps://")) {
        return Err("RTSP 地址无效，请填写以 rtsp:// 开头的视频流地址。".to_string());
    }

    let ffmpeg_path = find_ffmpeg_executable()?;
    let safe_camera_id = sanitize_camera_id(&camera_id);
    let port = ensure_preview_server()?;
    stop_preview_session(&safe_camera_id)?;

    let preview_dir = app_base_dir()?.join("previews").join(&safe_camera_id);
    if preview_dir.exists() {
        fs::remove_dir_all(&preview_dir).map_err(|error| format!("清理旧预览缓存失败: {error}"))?;
    }
    fs::create_dir_all(&preview_dir).map_err(|error| format!("创建预览缓存目录失败: {error}"))?;

    let log_path = log_dir()?.join(format!("ffmpeg-preview-{safe_camera_id}.log"));
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建日志目录失败: {error}"))?;
    }
    let mut log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("打开 FFmpeg 日志失败: {error}"))?;
    let _ = writeln!(log_file, "\n=== SmartST Lite RTSP preview start ===");
    let _ = writeln!(log_file, "rtsp_url={}", redact_rtsp_url(&rtsp_url));

    let mut command = Command::new(&ffmpeg_path);
    command
        .current_dir(&preview_dir)
        .args([
            "-hide_banner",
            "-loglevel",
            "warning",
            "-fflags",
            "nobuffer",
            "-flags",
            "low_delay",
            "-rtsp_transport",
            "tcp",
            "-i",
            &rtsp_url,
            "-an",
            "-vf",
            "scale=1280:-2",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-tune",
            "zerolatency",
            "-pix_fmt",
            "yuv420p",
            "-r",
            "15",
            "-g",
            "30",
            "-f",
            "hls",
            "-hls_time",
            "1",
            "-hls_list_size",
            "5",
            "-hls_flags",
            "delete_segments+omit_endlist+independent_segments",
            "-hls_segment_filename",
            "segment_%03d.ts",
            "index.m3u8",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log_file));
    apply_no_window(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 FFmpeg 失败: {error}"))?;

    let playlist_path = preview_dir.join("index.m3u8");
    let started = Instant::now();
    let mut message = "FFmpeg 已启动，正在生成本地预览流。".to_string();

    while started.elapsed() < Duration::from_secs(8) {
        if playlist_path.exists()
            && fs::metadata(&playlist_path)
                .map(|metadata| metadata.len() > 0)
                .unwrap_or(false)
        {
            message = "本地预览流已启动。".to_string();
            break;
        }

        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("读取 FFmpeg 状态失败: {error}"))?
        {
            return Err(format!(
                "FFmpeg 未能打开 RTSP 流，退出状态: {status}。请检查用户名、密码、RTSP 地址，并查看日志: {}",
                log_path.to_string_lossy()
            ));
        }

        thread::sleep(Duration::from_millis(250));
    }

    let playback_url = format!("http://127.0.0.1:{port}/preview/{safe_camera_id}/index.m3u8");
    PREVIEW_RUNTIME
        .lock()
        .map_err(|_| "预览服务状态锁定失败。".to_string())?
        .sessions
        .insert(
            safe_camera_id,
            PreviewProcess {
                child,
                directory: preview_dir,
            },
        );

    Ok(RtspPreviewSession {
        playback_url,
        log_path: log_path.to_string_lossy().to_string(),
        message,
    })
}

#[tauri::command]
fn stop_rtsp_preview(camera_id: String) -> Result<(), String> {
    let safe_camera_id = sanitize_camera_id(&camera_id);
    stop_preview_session(&safe_camera_id)
}

#[tauri::command]
fn discover_onvif_cameras() -> Result<Vec<DiscoveredOnvifCamera>, String> {
    let interfaces = discovery_interfaces();
    let targets = discovery_targets(&interfaces);
    let probes = build_ws_discovery_probes();
    let sockets = discovery_sockets(&interfaces);

    if sockets.is_empty() {
        return Err("未能打开 UDP 探测端口。请检查安全软件或防火墙设置。".to_string());
    }

    for socket in &sockets {
        for target in &targets {
            for probe in &probes {
                for _ in 0..2 {
                    let _ = socket.send_to(probe.as_bytes(), target);
                }
            }
        }
    }

    let started = Instant::now();
    let timeout = Duration::from_millis(5200);
    let mut buffer = [0_u8; 65_535];
    let mut discovered: HashMap<String, DiscoveredOnvifCamera> = HashMap::new();

    while started.elapsed() < timeout {
        let mut received_any = false;

        for socket in &sockets {
            loop {
                match socket.recv_from(&mut buffer) {
                    Ok((length, source)) => {
                        received_any = true;
                        let response = String::from_utf8_lossy(&buffer[..length]);
                        for camera in parse_onvif_probe_response(&response, source) {
                            let key = format!("{}:{}", camera.ip_address, camera.onvif_port);
                            discovered.entry(key).or_insert(camera);
                        }
                    }
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) =>
                    {
                        break;
                    }
                    Err(_) => {
                        break;
                    }
                }
            }
        }

        if !received_any {
            std::thread::sleep(Duration::from_millis(30));
        }
    }

    let mut cameras = discovered.into_values().collect::<Vec<_>>();
    cameras.sort_by(|left, right| {
        left.ip_address
            .cmp(&right.ip_address)
            .then(left.onvif_port.cmp(&right.onvif_port))
            .then(left.name.cmp(&right.name))
    });

    Ok(cameras)
}

fn discovery_interfaces() -> Vec<DiscoveryInterface> {
    let mut interfaces = vec![DiscoveryInterface {
        bind_ip: None,
        broadcast_ip: Some(Ipv4Addr::new(255, 255, 255, 255)),
    }];

    if let Ok(system_interfaces) = get_if_addrs() {
        for interface in system_interfaces {
            let IfAddr::V4(v4_addr) = interface.addr else {
                continue;
            };
            let ip = v4_addr.ip;

            if ip.is_loopback() || ip.is_unspecified() {
                continue;
            }

            interfaces.push(DiscoveryInterface {
                bind_ip: Some(ip),
                broadcast_ip: Some(ipv4_broadcast(ip, v4_addr.netmask)),
            });
        }
    }

    interfaces
}

fn discovery_targets(interfaces: &[DiscoveryInterface]) -> Vec<SocketAddr> {
    let mut targets = vec![
        WS_DISCOVERY_ADDRESS
            .parse::<SocketAddr>()
            .expect("valid WS-Discovery multicast address"),
        SocketAddr::new(
            IpAddr::V4(Ipv4Addr::new(255, 255, 255, 255)),
            WS_DISCOVERY_PORT,
        ),
    ];
    let mut seen = targets.iter().copied().collect::<HashSet<_>>();

    for interface in interfaces {
        if let Some(broadcast_ip) = interface.broadcast_ip {
            let target = SocketAddr::new(IpAddr::V4(broadcast_ip), WS_DISCOVERY_PORT);
            if seen.insert(target) {
                targets.push(target);
            }
        }
    }

    targets
}

fn discovery_sockets(interfaces: &[DiscoveryInterface]) -> Vec<UdpSocket> {
    let mut sockets = Vec::new();
    let mut seen_bindings = HashSet::new();

    for interface in interfaces {
        let bind_ip = interface.bind_ip.unwrap_or(Ipv4Addr::UNSPECIFIED);

        if !seen_bindings.insert(bind_ip) {
            continue;
        }

        if let Ok(socket) = UdpSocket::bind(SocketAddr::new(IpAddr::V4(bind_ip), 0)) {
            let _ = socket.set_nonblocking(true);
            let _ = socket.set_broadcast(true);
            let _ = socket.set_multicast_loop_v4(false);
            let _ = socket.set_multicast_ttl_v4(4);
            sockets.push(socket);
        }
    }

    sockets
}

fn ipv4_broadcast(ip: Ipv4Addr, netmask: Ipv4Addr) -> Ipv4Addr {
    let ip_value = u32::from(ip);
    let mask_value = u32::from(netmask);

    Ipv4Addr::from(ip_value | !mask_value)
}

fn onvif_post(url: &str, fallback_host: &str, body: &str) -> Result<String, String> {
    let target = parse_http_target(url)
        .or_else(|| parse_http_target(&replace_http_host(url, fallback_host)))
        .ok_or_else(|| format!("ONVIF 地址无效: {url}"))?;
    let mut last_error = None;

    for candidate in [
        target.clone(),
        HttpTarget {
            host: fallback_host.to_string(),
            port: target.port,
            path: target.path.clone(),
        },
    ] {
        match http_post(&candidate, body) {
            Ok(response) => return Ok(response),
            Err(error) => last_error = Some(error),
        }
    }

    Err(last_error.unwrap_or_else(|| "ONVIF HTTP 请求失败。".to_string()))
}

fn http_post(target: &HttpTarget, body: &str) -> Result<String, String> {
    let address = format!("{}:{}", target.host, target.port);
    let socket_addr = address
        .to_socket_addrs()
        .map_err(|error| format!("解析 ONVIF 地址失败 {address}: {error}"))?
        .next()
        .ok_or_else(|| format!("无法解析 ONVIF 地址: {address}"))?;
    let mut stream = TcpStream::connect_timeout(&socket_addr, Duration::from_secs(5))
        .map_err(|error| format!("连接 ONVIF 服务失败 {address}: {error}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(8)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let request = format!(
        "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/soap+xml; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        target.path,
        target.host,
        body.as_bytes().len(),
        body
    );

    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("发送 ONVIF 请求失败: {error}"))?;

    let mut bytes = Vec::new();
    stream
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取 ONVIF 响应失败: {error}"))?;
    let response = String::from_utf8_lossy(&bytes).to_string();
    let (header, body) = split_http_response(&response)?;
    let status_code = header
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);

    if !(200..300).contains(&status_code) {
        return Err(format!(
            "ONVIF 请求返回 HTTP {status_code}；请确认用户名、密码和 ONVIF 端口。"
        ));
    }

    if header
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        return Ok(decode_chunked_body(body).unwrap_or_else(|| body.to_string()));
    }

    Ok(body.to_string())
}

fn split_http_response(response: &str) -> Result<(&str, &str), String> {
    response
        .split_once("\r\n\r\n")
        .or_else(|| response.split_once("\n\n"))
        .ok_or_else(|| "ONVIF 响应不是有效 HTTP 格式。".to_string())
}

fn decode_chunked_body(body: &str) -> Option<String> {
    let mut decoded = Vec::new();
    let mut position = 0;
    let bytes = body.as_bytes();

    loop {
        let line_end = body[position..].find('\n')? + position;
        let size_text = body[position..line_end].trim();
        let size = usize::from_str_radix(size_text.split(';').next()?.trim(), 16).ok()?;
        position = line_end + 1;

        if size == 0 {
            break;
        }

        if position + size > bytes.len() {
            return None;
        }

        decoded.extend_from_slice(&bytes[position..position + size]);
        position += size;

        if body[position..].starts_with("\r\n") {
            position += 2;
        } else if body[position..].starts_with('\n') {
            position += 1;
        }
    }

    Some(String::from_utf8_lossy(&decoded).to_string())
}

fn parse_http_target(url: &str) -> Option<HttpTarget> {
    let rest = url.strip_prefix("http://")?;
    let (authority, path) = match rest.split_once('/') {
        Some((authority, path)) => (authority, format!("/{path}")),
        None => (rest, "/".to_string()),
    };
    let authority = authority.split('@').last()?;
    let (host, port) = if authority.starts_with('[') {
        let end = authority.find(']')?;
        let host = authority[1..end].to_string();
        let port = authority[end + 1..]
            .strip_prefix(':')
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(80);
        (host, port)
    } else if let Some((host, port)) = authority.rsplit_once(':') {
        (host.to_string(), port.parse::<u16>().ok()?)
    } else {
        (authority.to_string(), 80)
    };

    if host.is_empty() {
        return None;
    }

    Some(HttpTarget { host, port, path })
}

fn replace_http_host(url: &str, fallback_host: &str) -> String {
    let Some(rest) = url.strip_prefix("http://") else {
        return url.to_string();
    };
    let Some((authority, path)) = rest.split_once('/') else {
        return format!("http://{fallback_host}");
    };
    let port = parse_http_target(url)
        .map(|target| target.port)
        .filter(|port| *port != 80)
        .map(|port| format!(":{port}"))
        .unwrap_or_default();

    if authority.is_empty() {
        format!("http://{fallback_host}/{path}")
    } else {
        format!("http://{fallback_host}{port}/{path}")
    }
}

fn soap_envelope(body: &str, username: &str, password: &str) -> Result<String, String> {
    let security = if username.trim().is_empty() {
        String::new()
    } else {
        onvif_username_token(username, password)?
    };

    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:tds="http://www.onvif.org/ver10/device/wsdl"
            xmlns:trt="http://www.onvif.org/ver10/media/wsdl"
            xmlns:tt="http://www.onvif.org/ver10/schema">
  <s:Header>{security}</s:Header>
  <s:Body>{body}</s:Body>
</s:Envelope>"#
    ))
}

fn onvif_username_token(username: &str, password: &str) -> Result<String, String> {
    let created = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|error| format!("生成 ONVIF 时间戳失败: {error}"))?;
    let nonce_seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos().to_string())
        .unwrap_or_else(|_| "0".to_string());
    let nonce_raw = format!("smartst-lite-{nonce_seed}-{}", std::process::id());
    let nonce = BASE64.encode(nonce_raw.as_bytes());

    let mut hasher = Sha1::new();
    hasher.update(nonce_raw.as_bytes());
    hasher.update(created.as_bytes());
    hasher.update(password.as_bytes());
    let digest = BASE64.encode(hasher.finalize());

    Ok(format!(
        r#"<wsse:Security s:mustUnderstand="1"
                 xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
                 xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
  <wsse:UsernameToken>
    <wsse:Username>{}</wsse:Username>
    <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">{digest}</wsse:Password>
    <wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">{nonce}</wsse:Nonce>
    <wsu:Created>{created}</wsu:Created>
  </wsse:UsernameToken>
</wsse:Security>"#,
        xml_escape(username)
    ))
}

fn extract_onvif_profiles(xml: &str) -> Vec<OnvifProfile> {
    let mut profiles = Vec::new();
    let mut position = 0;

    while let Some(open_relative) = xml[position..].find('<') {
        let open_start = position + open_relative;
        let after_open = open_start + 1;

        if xml[after_open..].starts_with('/') {
            position = after_open;
            continue;
        }

        let Some(open_end_relative) = xml[after_open..].find('>') else {
            break;
        };
        let open_end = after_open + open_end_relative;
        let raw_tag = xml[after_open..open_end].trim();
        let tag_name = raw_tag.split_whitespace().next().unwrap_or_default();
        let tag_local_name = tag_name.rsplit(':').next().unwrap_or(tag_name);

        if !tag_local_name.eq_ignore_ascii_case("Profiles") {
            position = open_end + 1;
            continue;
        }

        let Some(token) = extract_xml_attribute(raw_tag, "token") else {
            position = open_end + 1;
            continue;
        };
        let close_tag = format!("</{tag_name}>");
        let content_start = open_end + 1;
        let Some(close_relative) = xml[content_start..].find(&close_tag) else {
            position = content_start;
            continue;
        };
        let content_end = content_start + close_relative;
        let content = &xml[content_start..content_end];
        let name = extract_xml_values(content, "Name")
            .into_iter()
            .next()
            .unwrap_or_else(|| token.clone());

        profiles.push(OnvifProfile { token, name });
        position = content_end + close_tag.len();
    }

    profiles
}

fn choose_onvif_profile(profiles: &[OnvifProfile]) -> Option<OnvifProfile> {
    profiles
        .iter()
        .find(|profile| {
            let text = format!("{} {}", profile.name, profile.token).to_ascii_lowercase();
            text.contains("main") || text.contains("profile_1") || text.contains("profile1")
        })
        .or_else(|| profiles.first())
        .cloned()
}

fn extract_xml_attribute(tag: &str, attribute: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let marker = format!("{attribute}={quote}");
        let Some(start) = tag.find(&marker).map(|start| start + marker.len()) else {
            continue;
        };
        let Some(end) = tag[start..].find(quote).map(|end| end + start) else {
            continue;
        };
        return Some(xml_unescape(&tag[start..end]));
    }

    None
}

fn rtsp_url_with_credentials(rtsp_url: &str, username: &str, password: &str) -> String {
    if username.trim().is_empty() || rtsp_url.contains('@') {
        return rtsp_url.to_string();
    }

    let Some((scheme, rest)) = rtsp_url.split_once("://") else {
        return rtsp_url.to_string();
    };
    let username = percent_encode_url_part(username.trim());
    let password = percent_encode_url_part(password);
    let auth = if password.is_empty() {
        username
    } else {
        format!("{username}:{password}")
    };

    format!("{scheme}://{auth}@{rest}")
}

fn percent_encode_url_part(input: &str) -> String {
    input
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

fn xml_escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn ensure_preview_server() -> Result<u16, String> {
    let mut runtime = PREVIEW_RUNTIME
        .lock()
        .map_err(|_| "预览服务状态锁定失败。".to_string())?;

    if let Some(port) = runtime.server_port {
        return Ok(port);
    }

    for port in PREVIEW_HTTP_PORT_START..=PREVIEW_HTTP_PORT_END {
        let address = format!("127.0.0.1:{port}");
        if let Ok(server) = Server::http(&address) {
            thread::spawn(move || run_preview_server(server));
            runtime.server_port = Some(port);
            return Ok(port);
        }
    }

    Err("无法启动本地预览服务，请检查 38180-38199 端口是否被占用。".to_string())
}

fn run_preview_server(server: Server) {
    for request in server.incoming_requests() {
        if request.method() == &Method::Options {
            let _ = request.respond(preview_http_response(204, Vec::new(), "text/plain"));
            continue;
        }

        let response = preview_file_response(request.url());
        let _ = request.respond(response);
    }
}

fn preview_file_response(url: &str) -> Response<Cursor<Vec<u8>>> {
    let Some((camera_id, file_name)) = parse_preview_url(url) else {
        return preview_http_response(404, b"Not found".to_vec(), "text/plain; charset=utf-8");
    };

    let directory = PREVIEW_RUNTIME.lock().ok().and_then(|runtime| {
        runtime
            .sessions
            .get(&camera_id)
            .map(|session| session.directory.clone())
    });

    let Some(directory) = directory else {
        return preview_http_response(
            404,
            b"Preview session not found".to_vec(),
            "text/plain; charset=utf-8",
        );
    };

    let path = directory.join(&file_name);
    if !path.starts_with(&directory) || !path.is_file() {
        return preview_http_response(
            404,
            b"Preview file not found".to_vec(),
            "text/plain; charset=utf-8",
        );
    }

    match fs::read(&path) {
        Ok(data) => preview_http_response(200, data, preview_content_type(&file_name)),
        Err(_) => preview_http_response(
            404,
            b"Preview file not readable".to_vec(),
            "text/plain; charset=utf-8",
        ),
    }
}

fn preview_http_response(
    status_code: u16,
    body: Vec<u8>,
    content_type: &str,
) -> Response<Cursor<Vec<u8>>> {
    Response::from_data(body)
        .with_status_code(StatusCode(status_code))
        .with_header(http_header("Access-Control-Allow-Origin", "*"))
        .with_header(http_header("Access-Control-Allow-Methods", "GET, OPTIONS"))
        .with_header(http_header("Access-Control-Allow-Headers", "*"))
        .with_header(http_header(
            "Cache-Control",
            "no-cache, no-store, must-revalidate",
        ))
        .with_header(http_header("Content-Type", content_type))
}

fn http_header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid HTTP header")
}

fn parse_preview_url(url: &str) -> Option<(String, String)> {
    let path = url.split('?').next()?.trim_start_matches('/');
    let mut parts = path.split('/');

    if parts.next()? != "preview" {
        return None;
    }

    let camera_id = parts.next()?.to_string();
    let file_name = parts.next()?.to_string();

    if parts.next().is_some()
        || camera_id.is_empty()
        || file_name.is_empty()
        || file_name.contains('\\')
        || file_name.contains('/')
        || file_name.contains("..")
    {
        return None;
    }

    Some((camera_id, file_name))
}

fn preview_content_type(file_name: &str) -> &'static str {
    if file_name.ends_with(".m3u8") {
        "application/vnd.apple.mpegurl"
    } else if file_name.ends_with(".ts") {
        "video/mp2t"
    } else {
        "application/octet-stream"
    }
}

fn stop_preview_session(camera_id: &str) -> Result<(), String> {
    let session = PREVIEW_RUNTIME
        .lock()
        .map_err(|_| "预览服务状态锁定失败。".to_string())?
        .sessions
        .remove(camera_id);

    if let Some(mut session) = session {
        let _ = session.child.kill();
        let _ = session.child.wait();
        let _ = fs::remove_dir_all(session.directory);
    }

    Ok(())
}

fn find_ffmpeg_executable() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("SMARTST_FFMPEG_PATH") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }

    if let Some(path) = medvision_runtime_binary("ffmpeg.exe") {
        return Ok(path);
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let bundled = exe_dir.join("ffmpeg.exe");
            if bundled.is_file() {
                return Ok(bundled);
            }
        }
    }

    if let Ok(current_dir) = std::env::current_dir() {
        let local = current_dir.join("ffmpeg.exe");
        if local.is_file() {
            return Ok(local);
        }
    }

    if command_is_available("ffmpeg") {
        return Ok(PathBuf::from("ffmpeg"));
    }

    Err(
        "未找到 FFmpeg。请将 ffmpeg.exe 放到 SmartST Lite.exe 同目录，或把 FFmpeg 加入系统 PATH。"
            .to_string(),
    )
}

fn medvision_runtime_binary(file_name: &str) -> Option<PathBuf> {
    let mut roots = Vec::new();
    if let Some(root) = std::env::var_os("MEDVISION_RUNTIME_DIR") {
        roots.push(PathBuf::from(root));
    }

    #[cfg(windows)]
    {
        if let Some(root) = std::env::var_os("ProgramW6432") {
            roots.push(PathBuf::from(root).join("MedVision").join("Runtime"));
        }
        if let Some(root) = std::env::var_os("ProgramFiles") {
            let root = PathBuf::from(root).join("MedVision").join("Runtime");
            if !roots.iter().any(|existing| existing == &root) {
                roots.push(root);
            }
        }
        if let Some(root) = std::env::var_os("LOCALAPPDATA") {
            roots.push(
                PathBuf::from(root)
                    .join("Programs")
                    .join("MedVision")
                    .join("Runtime"),
            );
        }
    }

    roots
        .into_iter()
        .map(|root| root.join("bin").join(file_name))
        .find(|candidate| candidate.is_file())
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

fn command_is_available(program: &str) -> bool {
    let mut command = Command::new(program);
    command
        .arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    apply_no_window(&mut command);

    command
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
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
        "smartst-native-worker.exe"
    } else {
        "smartst-native-worker"
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
        .unwrap_or_else(|| std::env::temp_dir().join("smartst-desktop-smoke-result.json"))
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
        "schemaVersion": "smartst.desktop-smoke.v0.1",
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

fn sanitize_camera_id(camera_id: &str) -> String {
    let sanitized = camera_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();

    if sanitized.is_empty() {
        "camera".to_string()
    } else {
        sanitized
    }
}

fn redact_rtsp_url(rtsp_url: &str) -> String {
    let Some((scheme, rest)) = rtsp_url.split_once("://") else {
        return rtsp_url.to_string();
    };
    let Some((_, host_and_path)) = rest.split_once('@') else {
        return rtsp_url.to_string();
    };

    format!("{scheme}://***:***@{host_and_path}")
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

fn build_ws_discovery_probes() -> Vec<String> {
    let message_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();

    vec![
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
            xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"
            xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
            xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <e:Header>
    <a:MessageID>uuid:smartst-lite-{message_id}</a:MessageID>
    <a:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To>
    <a:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action>
  </e:Header>
  <e:Body>
    <d:Probe>
      <d:Types>dn:NetworkVideoTransmitter</d:Types>
    </d:Probe>
  </e:Body>
</e:Envelope>"#
        ),
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
            xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"
            xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery">
  <e:Header>
    <a:MessageID>uuid:smartst-lite-generic-{message_id}</a:MessageID>
    <a:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To>
    <a:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action>
  </e:Header>
  <e:Body>
    <d:Probe />
  </e:Body>
</e:Envelope>"#
        ),
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:a="http://www.w3.org/2005/08/addressing"
            xmlns:d="http://docs.oasis-open.org/ws-dd/ns/discovery/2009/01"
            xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <s:Header>
    <a:MessageID>urn:uuid:smartst-lite-oasis-{message_id}</a:MessageID>
    <a:To>urn:docs-oasis-open-org:ws-dd:ns:discovery:2009:01</a:To>
    <a:Action>http://docs.oasis-open.org/ws-dd/ns/discovery/2009/01/Probe</a:Action>
  </s:Header>
  <s:Body>
    <d:Probe>
      <d:Types>dn:NetworkVideoTransmitter</d:Types>
    </d:Probe>
  </s:Body>
</s:Envelope>"#
        ),
    ]
}

fn parse_onvif_probe_response(xml: &str, source: SocketAddr) -> Vec<DiscoveredOnvifCamera> {
    let scopes = extract_xml_values(xml, "Scopes")
        .into_iter()
        .flat_map(|scope_text| {
            scope_text
                .split_whitespace()
                .map(percent_decode)
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    let mut xaddr_values = extract_xml_values(xml, "XAddrs")
        .into_iter()
        .flat_map(|xaddr_text| {
            xaddr_text
                .split_whitespace()
                .filter(|xaddr| xaddr.starts_with("http://") || xaddr.starts_with("https://"))
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    if xaddr_values.is_empty() {
        xaddr_values.push(format!(
            "http://{}:{}/onvif/device_service",
            source.ip(),
            80
        ));
    }

    xaddr_values
        .into_iter()
        .filter_map(|xaddr| {
            let (ip_address, onvif_port) = parse_xaddr_host_port(&xaddr, source)?;
            let name = camera_name_from_scopes(&scopes)
                .unwrap_or_else(|| format!("ONVIF 摄像机 {ip_address}"));
            let discovered_at = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_secs().to_string())
                .unwrap_or_else(|_| "0".to_string());

            Some(DiscoveredOnvifCamera {
                id: format!(
                    "onvif-{}-{}",
                    ip_address.replace(['.', ':'], "-"),
                    onvif_port
                ),
                name,
                ip_address,
                onvif_port,
                xaddr,
                scopes: scopes.clone(),
                source_address: source.to_string(),
                discovered_at,
            })
        })
        .collect()
}

fn extract_xml_values(xml: &str, local_name: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut position = 0;

    while let Some(open_relative) = xml[position..].find('<') {
        let open_start = position + open_relative;
        let after_open = open_start + 1;

        if xml[after_open..].starts_with('/') {
            position = after_open;
            continue;
        }

        let Some(open_end_relative) = xml[after_open..].find('>') else {
            break;
        };
        let open_end = after_open + open_end_relative;
        let raw_tag = xml[after_open..open_end].trim();

        if raw_tag.starts_with('?') || raw_tag.starts_with('!') || raw_tag.ends_with('/') {
            position = open_end + 1;
            continue;
        }

        let tag_name = raw_tag.split_whitespace().next().unwrap_or_default().trim();
        let tag_local_name = tag_name.rsplit(':').next().unwrap_or(tag_name);

        if !tag_local_name.eq_ignore_ascii_case(local_name) {
            position = open_end + 1;
            continue;
        }

        let close_tag = format!("</{tag_name}>");
        let content_start = open_end + 1;
        let Some(close_relative) = xml[content_start..].find(&close_tag) else {
            position = content_start;
            continue;
        };
        let content_end = content_start + close_relative;
        values.push(xml_unescape(xml[content_start..content_end].trim()));
        position = content_end + close_tag.len();
    }

    values
}

fn parse_xaddr_host_port(xaddr: &str, source: SocketAddr) -> Option<(String, String)> {
    let (default_port, rest) = if let Some(rest) = xaddr.strip_prefix("http://") {
        ("80", rest)
    } else if let Some(rest) = xaddr.strip_prefix("https://") {
        ("443", rest)
    } else {
        return None;
    };

    let authority = rest.split('/').next()?.split('@').last()?;
    let (host, port) = if authority.starts_with('[') {
        let end = authority.find(']')?;
        let host = authority[1..end].to_string();
        let port = authority[end + 1..]
            .strip_prefix(':')
            .unwrap_or(default_port)
            .to_string();
        (host, port)
    } else if let Some((host, port)) = authority.rsplit_once(':') {
        (host.to_string(), port.to_string())
    } else {
        (authority.to_string(), default_port.to_string())
    };

    if host.trim().is_empty() {
        return None;
    }

    let ip_address = if host.parse::<IpAddr>().is_ok() {
        host
    } else {
        source.ip().to_string()
    };

    Some((ip_address, port))
}

fn camera_name_from_scopes(scopes: &[String]) -> Option<String> {
    scope_value(scopes, "name")
        .or_else(|| scope_value(scopes, "hardware"))
        .or_else(|| scope_value(scopes, "location"))
        .map(|value| value.replace(['_', '-'], " "))
        .filter(|value| !value.trim().is_empty())
}

fn scope_value(scopes: &[String], key: &str) -> Option<String> {
    let marker = format!("/{key}/");
    scopes.iter().find_map(|scope| {
        let start = scope.find(&marker)? + marker.len();
        Some(scope[start..].trim_matches('/').to_string())
    })
}

fn percent_decode(input: &str) -> String {
    let mut output = Vec::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(hex) = u8::from_str_radix(&input[index + 1..index + 3], 16) {
                output.push(hex);
                index += 3;
                continue;
            }
        }

        output.push(bytes[index]);
        index += 1;
    }

    String::from_utf8_lossy(&output).to_string()
}

fn xml_unescape(input: &str) -> String {
    input
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
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
                            "schemaVersion": "smartst.desktop-smoke.v0.1",
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
                            "schemaVersion": "smartst.desktop-smoke.v0.1",
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
            stop_native_worker_session,
            resolve_rtsp_stream_uri,
            start_rtsp_preview,
            stop_rtsp_preview,
            discover_onvif_cameras
        ])
        .run(tauri::generate_context!())
        .expect("error while running SmartST Lite");
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
            assert_eq!(file_name, "smartst-native-worker.exe");
        } else {
            assert_eq!(file_name, "smartst-native-worker");
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
