import { useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, Maximize2, Radio, Star } from "lucide-react";
import type { CameraConfig } from "../domain/types";
import {
  startRtspPreview,
  stopRtspPreview,
  type RtspPreviewSession,
} from "../services/previewService";

interface VideoPaneProps {
  title: string;
  camera?: CameraConfig;
  variant?: "initiator" | "receiver";
  isPrimary?: boolean;
  emptyText?: string;
  onMakePrimary?: () => void;
}

type PreviewState =
  | { status: "idle"; message: string }
  | { status: "starting"; message: string }
  | ({ status: "ready" | "playing"; message: string } & RtspPreviewSession)
  | { status: "error"; message: string; logPath?: string };
type HlsInstance = InstanceType<typeof import("hls.js").default>;

export function VideoPane({
  title,
  camera,
  variant = "initiator",
  isPrimary = false,
  emptyText = "等待视频源",
  onMakePrimary,
}: VideoPaneProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [preview, setPreview] = useState<PreviewState>({
    status: "idle",
    message: "",
  });
  const [playbackError, setPlaybackError] = useState("");
  const hasSource = Boolean(camera?.rtspUrl);
  const shouldStartPreview = variant === "initiator" && Boolean(camera?.rtspUrl);
  const playbackUrl =
    preview.status === "ready" || preview.status === "playing"
      ? preview.playbackUrl
      : "";

  useEffect(() => {
    let cancelled = false;

    setPlaybackError("");
    setPreview({ status: "idle", message: "" });

    if (!camera?.id || !camera.rtspUrl || !shouldStartPreview) {
      return undefined;
    }

    setPreview({
      status: "starting",
      message: "正在启动 FFmpeg 本地预览...",
    });

    startRtspPreview(camera.id, camera.rtspUrl)
      .then((session) => {
        if (cancelled) {
          void stopRtspPreview(camera.id);
          return;
        }

        setPreview({
          status: "ready",
          ...session,
        });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        const message =
          error instanceof Error ? error.message : "RTSP 本地预览启动失败。";
        setPreview({ status: "error", message });
      });

    return () => {
      cancelled = true;
      void stopRtspPreview(camera.id);
    };
  }, [camera?.id, camera?.rtspUrl, shouldStartPreview]);

  useEffect(() => {
    const video = videoRef.current;

    if (!video || !playbackUrl) {
      return undefined;
    }

    let hls: HlsInstance | undefined;
    let disposed = false;
    setPlaybackError("");

    const markPlaying = () => {
      setPreview((current) =>
        current.status === "ready"
          ? {
              ...current,
              status: "playing",
              message: "正在播放本地预览。",
            }
          : current,
      );
    };

    const startPlayback = () => {
      video
        .play()
        .then(markPlaying)
        .catch(() => {
          setPlaybackError("预览流已生成，但自动播放被系统拦截，请点击视频区域播放。");
        });
    };

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = playbackUrl;
      video.addEventListener("loadedmetadata", startPlayback, { once: true });
    } else {
      void import("hls.js").then(({ default: Hls }) => {
        if (disposed) return;
        if (!Hls.isSupported()) {
          setPlaybackError("当前 WebView 不支持 HLS 播放。");
          return;
        }
        hls = new Hls({
          lowLatencyMode: true,
          backBufferLength: 20,
          maxBufferLength: 8,
        });
        hls.loadSource(playbackUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, startPlayback);
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            setPlaybackError("HLS 预览播放失败，请检查 RTSP 流或 FFmpeg 日志。");
            hls?.destroy();
          }
        });
      });
    }

    return () => {
      disposed = true;
      hls?.destroy();
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [playbackUrl]);

  const statusClass =
    preview.status === "playing"
      ? "connected"
      : preview.status === "ready" || preview.status === "starting"
        ? "connecting"
        : preview.status === "error" || playbackError
          ? "error"
          : camera?.status ?? "offline";
  const statusText = previewStatusText(preview, playbackError, camera);

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
        {(preview.status === "ready" || preview.status === "playing") && (
          <video
            className="preview-video"
            controls
            muted
            playsInline
            ref={videoRef}
            title={camera?.name ?? title}
          />
        )}

        {preview.status === "idle" && (
          <div className="video-placeholder">
            <Radio size={34} />
            <strong>{hasSource ? "准备本地预览" : emptyText}</strong>
            <span>
              {hasSource
                ? "Lite 会使用 FFmpeg 将 RTSP 转为本地 HLS 预览流。"
                : "当前没有可播放的视频流。"}
            </span>
          </div>
        )}

        {preview.status === "starting" && (
          <div className="preview-overlay">
            <Loader2 className="spin" size={30} />
            <strong>正在连接 RTSP</strong>
            <span>{preview.message}</span>
          </div>
        )}

        {(preview.status === "error" || playbackError) && (
          <div className="preview-overlay error">
            <AlertCircle size={30} />
            <strong>预览失败</strong>
            <span>{playbackError || preview.message}</span>
            {preview.status === "error" && preview.logPath && (
              <code>{preview.logPath}</code>
            )}
          </div>
        )}
      </div>

      <div className="video-meta">
        <span className={`status-pill ${statusClass}`}>{statusText}</span>
        <code>{camera?.rtspUrl || "rtsp://..."}</code>
      </div>
    </section>
  );
}

function previewStatusText(
  preview: PreviewState,
  playbackError: string,
  camera?: CameraConfig,
) {
  if (playbackError || preview.status === "error") {
    return "预览错误";
  }

  if (preview.status === "playing") {
    return "预览中";
  }

  if (preview.status === "ready") {
    return "已取流";
  }

  if (preview.status === "starting") {
    return "连接中";
  }

  if (camera?.status === "connected") {
    return "已连接";
  }

  if (camera?.status === "saved") {
    return "已保存";
  }

  return "未连接";
}
