#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use get_if_addrs::{get_if_addrs, IfAddr};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket},
    path::PathBuf,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const APP_DIR_NAME: &str = "SmartST Lite";
const CONFIG_FILE_NAME: &str = "config.json";
const LOG_FILE_NAME: &str = "smartst-lite.log";
const WS_DISCOVERY_ADDRESS: &str = "239.255.255.250:3702";
const WS_DISCOVERY_PORT: u16 = 3702;

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
        .invoke_handler(tauri::generate_handler![
            get_default_paths,
            load_config,
            save_config,
            append_log,
            discover_onvif_cameras
        ])
        .run(tauri::generate_context!())
        .expect("error while running SmartST Lite");
}
