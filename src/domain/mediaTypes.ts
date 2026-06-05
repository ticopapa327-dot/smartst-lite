export type VideoChannelRole =
  | "field"
  | "panorama"
  | "endoscope"
  | "device"
  | "auxiliary";

export type VideoSourceKind = "usb" | "rtsp" | "srt" | "screen" | "test";

export type VideoChannelHealth =
  | "unknown"
  | "healthy"
  | "degraded"
  | "offline"
  | "error";

export interface VideoChannel {
  id: string;
  displayName: string;
  role: VideoChannelRole;
  kind: VideoSourceKind;
  enabled: boolean;
  healthy: boolean;
  health: VideoChannelHealth;
  localPrimary: boolean;
  remoteDefault: boolean;
  priority: number;
  preferredWidth?: number;
  preferredHeight?: number;
  preferredFrameRate?: number;
  deviceId?: string;
  trackName?: string;
  lastSeenAt?: string;
}

export type AudioDeviceKind = "input" | "output";

export interface AudioEndpoint {
  id: string;
  deviceId: string;
  displayName: string;
  kind: AudioDeviceKind;
  enabled: boolean;
  defaultDevice: boolean;
}

export type PtzProtocol = "none" | "uvc" | "visca" | "vendor-sdk" | "onvif";

export interface PtzCapabilities {
  protocol: PtzProtocol;
  panTilt: boolean;
  zoom: boolean;
  focus: boolean;
  iris: boolean;
  presets: boolean;
}

export type PtzMoveDirection =
  | "up"
  | "down"
  | "left"
  | "right"
  | "up-left"
  | "up-right"
  | "down-left"
  | "down-right"
  | "stop";

export interface PtzCommand {
  channelId: string;
  direction?: PtzMoveDirection;
  zoomDelta?: number;
  focusDelta?: number;
  irisDelta?: number;
  presetId?: string;
}

export interface MediaStats {
  channelId: string;
  width?: number;
  height?: number;
  frameRate?: number;
  bitrateKbps?: number;
  droppedFrames?: number;
  audioLevel?: number;
  updatedAt: string;
}

