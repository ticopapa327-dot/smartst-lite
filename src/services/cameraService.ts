import { invoke } from "@tauri-apps/api/core";
import type { CameraConfig, DiscoveredOnvifCamera } from "../domain/types";
import { isTauriRuntime } from "./configService";

export const MAX_CAMERAS = 2;

export interface CameraDraft {
  name: string;
  ipAddress: string;
  onvifPort: string;
  username: string;
  password: string;
  rtspUrl: string;
}

export interface RtspStreamResolution {
  rtspUrl: string;
  profileToken: string;
  profileName: string;
  mediaXaddr: string;
  message: string;
}

export async function discoverOnvifCameras(): Promise<DiscoveredOnvifCamera[]> {
  if (!isTauriRuntime()) {
    throw new Error("自动发现需要在 SmartST Lite Windows 桌面客户端中运行。");
  }

  return invoke<DiscoveredOnvifCamera[]>("discover_onvif_cameras");
}

export async function resolveRtspStreamUri(
  draft: CameraDraft,
): Promise<RtspStreamResolution> {
  if (!isTauriRuntime()) {
    throw new Error("ONVIF 获取 RTSP 地址需要在 SmartST Lite Windows 桌面客户端中运行。");
  }

  return invoke<RtspStreamResolution>("resolve_rtsp_stream_uri", {
    ipAddress: draft.ipAddress,
    onvifPort: draft.onvifPort,
    username: draft.username,
    password: draft.password,
  });
}

export function draftFromDiscoveredCamera(
  camera: DiscoveredOnvifCamera,
): CameraDraft {
  return {
    name: camera.name,
    ipAddress: camera.ipAddress,
    onvifPort: camera.onvifPort || "80",
    username: "",
    password: "",
    rtspUrl: "",
  };
}

export function createCameraConfig(
  draft: CameraDraft,
  index: number,
): CameraConfig {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: draft.name.trim() || `摄像机 ${index + 1}`,
    ipAddress: draft.ipAddress.trim(),
    onvifPort: draft.onvifPort.trim() || "80",
    username: draft.username.trim(),
    password: draft.password,
    rtspUrl: draft.rtspUrl.trim() || buildRtspCandidate(draft),
    role: index === 0 ? "primary" : "secondary",
    status: "saved",
    note: draft.rtspUrl.trim()
      ? "RTSP 地址来自 ONVIF GetStreamUri 或手动填写。"
      : "未获取到 ONVIF StreamUri，已使用常见格式候选地址。",
    createdAt: now,
    updatedAt: now,
  };
}

export function updateCameraConfig(
  current: CameraConfig,
  draft: CameraDraft,
): CameraConfig {
  return {
    ...current,
    name: draft.name.trim() || current.name,
    ipAddress: draft.ipAddress.trim(),
    onvifPort: draft.onvifPort.trim() || "80",
    username: draft.username.trim(),
    password: draft.password,
    rtspUrl: draft.rtspUrl.trim() || buildRtspCandidate(draft),
    status: "saved",
    note: draft.rtspUrl.trim()
      ? "RTSP 地址来自 ONVIF GetStreamUri 或手动填写。"
      : "未获取到 ONVIF StreamUri，已使用常见格式候选地址。",
    updatedAt: new Date().toISOString(),
  };
}

export function validateCameraDraft(draft: CameraDraft): string | null {
  if (!draft.ipAddress.trim()) {
    return "请输入摄像机 IP 地址；输入框里的示例文字不会自动保存。";
  }

  if (!draft.onvifPort.trim()) {
    return "请输入 ONVIF 端口。";
  }

  return null;
}

function buildRtspCandidate(draft: CameraDraft): string {
  const host = draft.ipAddress.trim() || "camera-ip";
  const username = encodeURIComponent(draft.username.trim());
  const password = encodeURIComponent(draft.password);
  const auth = username ? `${username}${password ? `:${password}` : ""}@` : "";

  return `rtsp://${auth}${host}:554/Streaming/Channels/101`;
}
