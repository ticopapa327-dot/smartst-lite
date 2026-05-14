import { invoke } from "@tauri-apps/api/core";
import type { AppConfig, DefaultPaths } from "../domain/types";

const STORAGE_KEY = "smartst-lite-config";

export const defaultSettings = {
  serverUrl: "http://127.0.0.1:7880",
  organizationName: "未命名机构",
  deviceName: "SmartST Lite Windows 终端",
  logDirectory: "",
};

export const defaultConfig: AppConfig = {
  settings: defaultSettings,
  cameras: [],
  recentConnections: [],
  roomSession: {
    roomCode: "",
    status: "idle",
  },
};

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function getDefaultPaths(): Promise<DefaultPaths> {
  if (isTauriRuntime()) {
    try {
      return await invoke<DefaultPaths>("get_default_paths");
    } catch (error) {
      console.warn("Failed to read Tauri default paths", error);
    }
  }

  return {
    configPath: "localStorage://smartst-lite-config",
    logDirectory: "localStorage://smartst-lite-logs",
  };
}

export async function loadAppConfig(): Promise<AppConfig> {
  if (isTauriRuntime()) {
    try {
      const stored = await invoke<AppConfig | null>("load_config");
      if (stored) {
        return normalizeConfig(stored);
      }
    } catch (error) {
      console.warn("Failed to load config through Tauri", error);
    }
  }

  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return defaultConfig;
  }

  try {
    return normalizeConfig(JSON.parse(raw) as AppConfig);
  } catch (error) {
    console.warn("Failed to parse local config", error);
    return defaultConfig;
  }
}

export async function saveAppConfig(config: AppConfig): Promise<void> {
  const normalized = normalizeConfig(config);

  if (isTauriRuntime()) {
    try {
      await invoke("save_config", { config: normalized });
      return;
    } catch (error) {
      console.warn("Failed to save config through Tauri", error);
    }
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
}

function normalizeConfig(config: Partial<AppConfig>): AppConfig {
  return {
    settings: {
      ...defaultSettings,
      ...(config.settings ?? {}),
    },
    cameras: (config.cameras ?? []).slice(0, 2),
    recentConnections: (config.recentConnections ?? []).slice(0, 8),
    roomSession: {
      ...defaultConfig.roomSession,
      ...(config.roomSession ?? {}),
    },
  };
}
