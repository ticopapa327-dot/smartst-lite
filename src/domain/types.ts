export type AppView = "startup" | "workbench" | "settings";

export interface AppSettings {
  serverUrl: string;
  organizationName: string;
  deviceName: string;
  logDirectory: string;
}

export interface AppConfig {
  settings: AppSettings;
  usbVideoChannelBindings: UsbVideoChannelBindings;
}

export interface UsbVideoChannelBinding {
  index?: number;
  deviceId?: string;
  nativeId?: string;
  displayNameContains?: string;
}

export type UsbVideoChannelBindings = Record<string, UsbVideoChannelBinding>;

export interface DefaultPaths {
  configPath: string;
  logDirectory: string;
}

export interface LogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
  context?: Record<string, unknown>;
  logDirectory?: string;
}
