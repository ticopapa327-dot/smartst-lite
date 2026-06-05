export type AppView =
  | "startup"
  | "workbench"
  | "initiator"
  | "receiver"
  | "settings";

export type CameraRole = "primary" | "secondary";

export type CameraStatus =
  | "saved"
  | "connecting"
  | "connected"
  | "offline"
  | "error";

export type RoomStatus = "idle" | "created" | "calling" | "connected";

export interface CameraConfig {
  id: string;
  name: string;
  ipAddress: string;
  onvifPort: string;
  username: string;
  password: string;
  rtspUrl: string;
  role: CameraRole;
  status: CameraStatus;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DiscoveredOnvifCamera {
  id: string;
  name: string;
  ipAddress: string;
  onvifPort: string;
  xaddr: string;
  scopes: string[];
  sourceAddress: string;
  discoveredAt: string;
}

export interface AppSettings {
  serverUrl: string;
  organizationName: string;
  deviceName: string;
  logDirectory: string;
}

export interface RecentConnection {
  id: string;
  label: string;
  endpoint: string;
  roomCode: string;
  lastConnectedAt: string;
}

export interface RoomSession {
  roomCode: string;
  status: RoomStatus;
  createdAt?: string;
  updatedAt?: string;
  message?: string;
}

export interface AppConfig {
  settings: AppSettings;
  cameras: CameraConfig[];
  recentConnections: RecentConnection[];
  roomSession: RoomSession;
}

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
