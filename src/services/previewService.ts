import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./configService";

export interface RtspPreviewSession {
  playbackUrl: string;
  logPath: string;
  message: string;
}

export async function startRtspPreview(
  cameraId: string,
  rtspUrl: string,
): Promise<RtspPreviewSession> {
  if (!isTauriRuntime()) {
    throw new Error("RTSP 本地预览需要在 SmartST Lite Windows 桌面客户端中运行。");
  }

  return invoke<RtspPreviewSession>("start_rtsp_preview", {
    cameraId,
    rtspUrl,
  });
}

export async function stopRtspPreview(cameraId: string): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }

  await invoke("stop_rtsp_preview", { cameraId });
}
