#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
};

const APP_DIR_NAME: &str = "SmartST Lite";
const CONFIG_FILE_NAME: &str = "config.json";
const LOG_FILE_NAME: &str = "smartst-lite.log";

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
        .invoke_handler(tauri::generate_handler![
            get_default_paths,
            load_config,
            save_config,
            append_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running SmartST Lite");
}
