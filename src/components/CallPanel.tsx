import { useState } from "react";
import {
  CheckCircle2,
  PhoneCall,
  RadioTower,
  Smartphone,
  Tablet,
  Users,
} from "lucide-react";
import type { VideoChannel } from "../domain/mediaTypes";
import {
  createDesktopCallSession,
  type BusinessCallMode,
  type BusinessCallSession,
} from "../services/businessService";
import type { LiveKitConnectionDraft } from "../services/livekitRoomService";

interface CallPanelProps {
  defaultChannel?: VideoChannel;
  onLiveKitDraft?: (draft: LiveKitConnectionDraft) => void;
}

export function CallPanel({ defaultChannel, onLiveKitDraft }: CallPanelProps) {
  const [businessUrl, setBusinessUrl] = useState(defaultBusinessUrl());
  const [mode, setMode] = useState<BusinessCallMode>("interactive");
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<BusinessCallSession | null>(null);
  const [error, setError] = useState("");

  async function startBusinessCall() {
    setBusy(true);
    setError("");
    try {
      const nextSession = await createDesktopCallSession({
        businessUrl,
        defaultChannel,
        mode,
      });
      setSession(nextSession);
      onLiveKitDraft?.({
        id: nextSession.id,
        serverUrl: nextSession.livekitUrl,
        token: nextSession.token,
        mode: nextSession.mode,
        publishCamera: false,
        publishMicrophone: false,
        roomCode: nextSession.roomCode,
        defaultChannelId: nextSession.defaultChannelId,
        defaultTrackName: nextSession.defaultTrackName,
        source: "business-call-panel",
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "业务呼叫失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="hmi-panel call-panel">
      <div className="hmi-section-heading">
        <div>
          <span>Teaching Session</span>
          <h2>呼叫与媒体策略</h2>
        </div>
        <strong>PoC</strong>
      </div>

      <div className="policy-list">
        <div className="policy-item">
          <RadioTower size={18} />
          <div>
            <strong>{defaultChannel?.displayName ?? "未选择默认画面"}</strong>
            <span>连接建立后默认发布一路画面，不默认发布全部 4 路。</span>
          </div>
        </div>
        <div className="policy-item">
          <Smartphone size={18} />
          <div>
            <strong>手机 H5：单向收看</strong>
            <span>只订阅默认画面和手术室音频，由 LiveKit/SFU 承担并发转发。</span>
          </div>
        </div>
        <div className="policy-item">
          <Tablet size={18} />
          <div>
            <strong>Android 会议平板：正式客户端</strong>
            <span>按 tablet-watch / tablet-interactive token 策略入房。</span>
          </div>
        </div>
        <div className="policy-item">
          <Users size={18} />
          <div>
            <strong>人数限制</strong>
            <span>交互终端、会议平板、手机观察者分别计数。</span>
          </div>
        </div>
      </div>

      <div className="livekit-form call-service-form">
        <label>
          UST Server
          <input
            className="hmi-input"
            onChange={(event) => setBusinessUrl(event.target.value)}
            placeholder="http://127.0.0.1:4780"
            value={businessUrl}
          />
        </label>
      </div>

      <div className="livekit-options call-mode-options">
        <button
          className={`hmi-segment ${mode === "watch" ? "active" : ""}`}
          onClick={() => setMode("watch")}
          type="button"
        >
          <Smartphone size={15} />
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

      {session && (
        <div className="call-session-result">
          <CheckCircle2 size={16} />
          <div>
            <strong>{session.roomCode}</strong>
            <span>
              {session.message} / {session.defaultTrackName ?? "no-default-track"}
            </span>
          </div>
        </div>
      )}

      {error && <div className="native-worker-alert">{error}</div>}

      <div className="hmi-action-row">
        <button
          className="hmi-button primary"
          disabled={busy}
          onClick={startBusinessCall}
          type="button"
        >
          <PhoneCall size={17} />
          {busy ? "呼叫中" : "呼叫并入会"}
        </button>
        <button className="hmi-button" disabled type="button">
          生成手机观看码
        </button>
      </div>
    </section>
  );
}

function defaultBusinessUrl() {
  if (typeof window === "undefined") return "http://127.0.0.1:4780";
  const host = window.location.hostname;
  if (
    host &&
    host !== "localhost" &&
    host !== "127.0.0.1" &&
    !host.includes("tauri")
  ) {
    return `http://${host}:4780`;
  }
  return "http://127.0.0.1:4780";
}
