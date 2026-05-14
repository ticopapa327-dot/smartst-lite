import { Maximize2, Radio, Star } from "lucide-react";
import type { CameraConfig } from "../domain/types";

interface VideoPaneProps {
  title: string;
  camera?: CameraConfig;
  variant?: "initiator" | "receiver";
  isPrimary?: boolean;
  emptyText?: string;
  onMakePrimary?: () => void;
}

export function VideoPane({
  title,
  camera,
  variant = "initiator",
  isPrimary = false,
  emptyText = "等待视频源",
  onMakePrimary,
}: VideoPaneProps) {
  const hasSource = Boolean(camera?.rtspUrl);

  return (
    <section className={`video-pane ${isPrimary ? "primary" : ""}`}>
      <div className="video-topbar">
        <div>
          <div className="video-title">{title}</div>
          <div className="video-subtitle">
            {camera?.name ?? (variant === "receiver" ? "远端视频源" : "未选择摄像机")}
          </div>
        </div>
        <div className="video-actions">
          {onMakePrimary && (
            <button
              className="icon-button"
              onClick={onMakePrimary}
              title="设为主画面"
              type="button"
            >
              <Star size={17} />
            </button>
          )}
          <button className="icon-button" disabled title="全屏预览 TODO" type="button">
            <Maximize2 size={17} />
          </button>
        </div>
      </div>

      <div className="video-surface">
        <div className="video-placeholder">
          <Radio size={34} />
          <strong>{hasSource ? "RTSP 源已配置" : emptyText}</strong>
          <span>
            {hasSource
              ? "TODO: 使用 FFmpeg 拉流并推送到 WebRTC/LiveKit 后显示真实画面。"
              : "当前没有可播放的视频流。"}
          </span>
        </div>
      </div>

      <div className="video-meta">
        <span className={`status-pill ${camera?.status ?? "offline"}`}>
          {camera?.status === "connected"
            ? "已连接"
            : camera?.status === "error"
              ? "错误"
              : camera?.status === "saved"
                ? "已保存"
                : "未连接"}
        </span>
        <code>{camera?.rtspUrl || "rtsp://..."}</code>
      </div>
    </section>
  );
}
