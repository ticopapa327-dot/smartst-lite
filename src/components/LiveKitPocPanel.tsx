import { useEffect, useRef, useState } from "react";
import { Link, RadioTower, ShieldCheck, Video } from "lucide-react";
import {
  connectLiveKitPoc,
  type LiveKitConnectionDraft,
  type LiveKitPocMode,
  type LiveKitPocSession,
  type LiveKitPocStatus,
  type LiveKitRemoteTrackInfo,
} from "../services/livekitRoomService";

interface LiveKitPocPanelProps {
  connectionDraft?: LiveKitConnectionDraft;
}

export function LiveKitPocPanel({ connectionDraft }: LiveKitPocPanelProps) {
  const sessionRef = useRef<LiveKitPocSession | null>(null);
  const [serverUrl, setServerUrl] = useState("ws://127.0.0.1:7880");
  const [token, setToken] = useState("");
  const [mode, setMode] = useState<LiveKitPocMode>("watch");
  const [publishCamera, setPublishCamera] = useState(false);
  const [publishMicrophone, setPublishMicrophone] = useState(false);
  const [status, setStatus] = useState<LiveKitPocStatus>("idle");
  const [message, setMessage] = useState(
    "填写 LiveKit URL 和短期 JWT token 后可手动连接。",
  );
  const [remoteTracks, setRemoteTracks] = useState<LiveKitRemoteTrackInfo[]>([]);

  const isConnected = status === "connected";
  const isBusy = status === "connecting" || status === "disconnecting";
  const canPublish = mode === "interactive";
  const remoteVideoTracks = remoteTracks.filter((track) => track.kind === "video");
  const remoteAudioTracks = remoteTracks.filter((track) => track.kind === "audio");

  useEffect(() => {
    return () => {
      void sessionRef.current?.disconnect();
      sessionRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!connectionDraft) return;
    setServerUrl(connectionDraft.serverUrl);
    setToken(connectionDraft.token);
    setMode(connectionDraft.mode);
    setPublishCamera(connectionDraft.publishCamera === true);
    setPublishMicrophone(connectionDraft.publishMicrophone === true);
    setMessage(
      `业务呼叫已接受：${connectionDraft.roomCode ?? "room"} / 默认轨道 ${
        connectionDraft.defaultTrackName ?? "未返回"
      }`,
    );
    void connectWithOptions(connectionDraft);
  }, [connectionDraft?.id]);

  async function connectWithOptions(options?: LiveKitConnectionDraft) {
    if (sessionRef.current) {
      await disconnect();
    }

    const nextServerUrl = options?.serverUrl ?? serverUrl;
    const nextToken = options?.token ?? token;
    const nextMode = options?.mode ?? mode;
    const nextPublishCamera =
      options?.publishCamera ?? (canPublish && publishCamera);
    const nextPublishMicrophone =
      options?.publishMicrophone ?? (canPublish && publishMicrophone);

    setRemoteTracks([]);
    try {
      sessionRef.current = await connectLiveKitPoc({
        serverUrl: nextServerUrl,
        token: nextToken,
        mode: nextMode,
        publishCamera: nextMode === "interactive" && nextPublishCamera,
        publishMicrophone: nextMode === "interactive" && nextPublishMicrophone,
        onStatus: (nextStatus, nextMessage) => {
          setStatus(nextStatus);
          if (nextMessage) setMessage(nextMessage);
        },
        onRemoteTrack: (trackInfo) => {
          setRemoteTracks((current) => {
            const exists = current.some(
              (item) => getTrackKey(item) === getTrackKey(trackInfo),
            );
            return exists ? current : [...current, trackInfo];
          });
        },
        onRemoteTrackUnsubscribed: (trackInfo) => {
          setRemoteTracks((current) =>
            current.filter((item) => getTrackKey(item) !== getTrackKey(trackInfo)),
          );
        },
      });
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "LiveKit 连接失败。");
      sessionRef.current = null;
    }
  }

  async function connect() {
    await connectWithOptions();
  }

  async function disconnect() {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (!session) {
      setStatus("disconnected");
      setMessage("当前没有 LiveKit 连接。");
      return;
    }
    await session.disconnect();
    setRemoteTracks([]);
  }

  return (
    <section className="hmi-panel livekit-poc-panel">
      <div className="hmi-section-heading">
        <div>
          <span>LiveKit PoC</span>
          <h2>实时互动验证</h2>
        </div>
        <strong>{statusLabel(status)}</strong>
      </div>

      <div className="livekit-form">
        <label>
          LiveKit URL
          <input
            className="hmi-input"
            onChange={(event) => setServerUrl(event.target.value)}
            placeholder="ws://127.0.0.1:7880"
            value={serverUrl}
          />
        </label>
        <label>
          短期 JWT token
          <input
            className="hmi-input"
            onChange={(event) => setToken(event.target.value)}
            placeholder="由业务服务签发，不能填写 API secret"
            value={token}
          />
        </label>
      </div>

      <div className="livekit-options">
        <button
          className={`hmi-segment ${mode === "watch" ? "active" : ""}`}
          onClick={() => {
            setMode("watch");
            setPublishCamera(false);
            setPublishMicrophone(false);
          }}
          type="button"
        >
          <ShieldCheck size={15} />
          仅收看
        </button>
        <button
          className={`hmi-segment ${mode === "interactive" ? "active" : ""}`}
          onClick={() => setMode("interactive")}
          type="button"
        >
          <RadioTower size={15} />
          交互
        </button>
      </div>

      <div className="livekit-toggles">
        <label className={!canPublish ? "disabled" : ""}>
          <input
            checked={publishCamera}
            disabled={!canPublish}
            onChange={(event) => setPublishCamera(event.target.checked)}
            type="checkbox"
          />
          发布摄像头
        </label>
        <label className={!canPublish ? "disabled" : ""}>
          <input
            checked={publishMicrophone}
            disabled={!canPublish}
            onChange={(event) => setPublishMicrophone(event.target.checked)}
            type="checkbox"
          />
          发布麦克风
        </label>
      </div>

      <div className={`livekit-status ${status}`}>
        <Link size={16} />
        <span>{message}</span>
      </div>

      <div className="livekit-preview">
        {remoteVideoTracks.length === 0 ? (
          <div className="livekit-preview-empty">
            <Video size={18} />
            <span>远端默认画面待订阅</span>
          </div>
        ) : (
          remoteVideoTracks.map((track, index) => (
            <RemoteTrackPreview
              featured={index === 0}
              key={getTrackKey(track)}
              trackInfo={track}
            />
          ))
        )}
        {remoteAudioTracks.map((track) => (
          <RemoteAudioMount key={getTrackKey(track)} trackInfo={track} />
        ))}
      </div>

      <div className="remote-track-list">
        {remoteTracks.length === 0 && (
          <div className="remote-track-empty">
            <Video size={16} />
            尚未订阅到远端轨道。连接真实 LiveKit room 后会显示 track 信息。
          </div>
        )}
        {remoteTracks.map((track) => (
          <div
            className="remote-track-item"
            key={`${track.participantIdentity}-${track.trackSid ?? track.trackName}`}
          >
            <strong>{track.trackName || track.trackSid || "remote-track"}</strong>
            <span>
              {track.participantIdentity} / {track.kind} /{" "}
              {track.source ?? "unknown"}
            </span>
          </div>
        ))}
      </div>

      <div className="hmi-action-row">
        <button
          className="hmi-button primary"
          disabled={isBusy || isConnected}
          onClick={connect}
          type="button"
        >
          连接
        </button>
        <button
          className="hmi-button"
          disabled={isBusy || !sessionRef.current}
          onClick={disconnect}
          type="button"
        >
          断开
        </button>
      </div>
    </section>
  );
}

function statusLabel(status: LiveKitPocStatus) {
  switch (status) {
    case "connecting":
      return "连接中";
    case "connected":
      return "已连接";
    case "disconnecting":
      return "断开中";
    case "disconnected":
      return "已断开";
    case "error":
      return "错误";
    default:
      return "未连接";
  }
}

function RemoteTrackPreview({
  featured,
  trackInfo,
}: {
  featured: boolean;
  trackInfo: LiveKitRemoteTrackInfo;
}) {
  const mediaRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = mediaRef.current;
    if (!container) return;

    const element = trackInfo.track.attach();
    element.autoplay = true;
    element.controls = false;
    element.className = "livekit-media-element";
    if (element instanceof HTMLVideoElement) {
      element.playsInline = true;
    }
    container.replaceChildren(element);

    return () => {
      trackInfo.track.detach(element);
      element.remove();
    };
  }, [trackInfo]);

  return (
    <div className={`livekit-preview-tile ${featured ? "featured" : ""}`}>
      <div className="livekit-media-host" ref={mediaRef} />
      <div className="livekit-preview-caption">
        <strong>{trackInfo.trackName || trackInfo.source || "remote-video"}</strong>
        <span>{trackInfo.participantIdentity}</span>
      </div>
    </div>
  );
}

function RemoteAudioMount({ trackInfo }: { trackInfo: LiveKitRemoteTrackInfo }) {
  const audioRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = audioRef.current;
    if (!container) return;

    const element = trackInfo.track.attach();
    element.autoplay = true;
    element.controls = false;
    element.className = "livekit-audio-element";
    container.replaceChildren(element);

    return () => {
      trackInfo.track.detach(element);
      element.remove();
    };
  }, [trackInfo]);

  return <div className="livekit-audio-host" ref={audioRef} />;
}

function getTrackKey(track: LiveKitRemoteTrackInfo) {
  return [
    track.participantIdentity,
    track.trackSid ?? track.trackName ?? track.source ?? track.kind,
  ].join(":");
}
