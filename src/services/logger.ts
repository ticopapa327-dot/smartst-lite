import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, LogEntry } from "../domain/types";
import { isTauriRuntime } from "./configService";

const LOG_STORAGE_KEY = "ust-desktop-client-logs";

export async function writeLog(
  level: LogEntry["level"],
  message: string,
  context?: Record<string, unknown>,
  settings?: AppSettings,
): Promise<void> {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    context,
    logDirectory: settings?.logDirectory,
  };

  if (isTauriRuntime()) {
    try {
      await invoke("append_log", { entry });
      return;
    } catch (error) {
      console.warn("Failed to append native log", error);
    }
  }

  const current = JSON.parse(
    window.localStorage.getItem(LOG_STORAGE_KEY) ?? "[]",
  ) as LogEntry[];
  const next = [...current, entry].slice(-300);
  window.localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(next));
  console[level === "error" ? "error" : level === "warn" ? "warn" : "info"](
    `[视捷UST] ${message}`,
    context ?? {},
  );
}
