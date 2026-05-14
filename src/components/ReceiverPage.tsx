import { useState } from "react";
import { DoorOpen, PhoneOff, RadioReceiver, Save, Waves } from "lucide-react";
import type { AppConfig, RecentConnection } from "../domain/types";
import { createRecentConnection } from "../services/realtimeService";
import { VideoPane } from "./VideoPane";

interface ReceiverPageProps {
  config: AppConfig;
  onConfigChange: (updater: (current: AppConfig) => AppConfig) => void;
  onLog: (
    level: "info" | "warn" | "error",
    message: string,
    context?: Record<string, unknown>,
  ) => void;
}

export function ReceiverPage({
  config,
  onConfigChange,
  onLog,
}: ReceiverPageProps) {
  const [endpoint, setEndpoint] = useState(config.settings.serverUrl);
  const [roomCode, setRoomCode] = useState("");
  const [sessionState, setSessionState] = useState<
    "idle" | "waiting" | "joined-local"
  >("idle");

  function joinRoom() {
    const recent = createRecentConnection(endpoint, roomCode);
    setSessionState("joined-local");
    onConfigChange((current) => ({
      ...current,
      recentConnections: upsertRecent(current.recentConnections, recent),
    }));
    onLog("warn", "Join room requested but LiveKit/WebRTC is TODO", {
      endpoint,
      roomCode,
    });
  }

  function waitForCall() {
    setSessionState("waiting");
    onLog("info", "Receiver entered waiting state", { endpoint });
  }

  function hangUp() {
    setSessionState("idle");
    onLog("info", "Receiver session ended", { roomCode });
  }

  function loadRecent(recent: RecentConnection) {
    setEndpoint(recent.endpoint);
    setRoomCode(recent.roomCode);
  }

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <div className="eyebrow">
            <RadioReceiver size={17} />
            示教接收端
          </div>
          <h1>远程观摩终端</h1>
        </div>
        <div className="header-actions">
          <button className="secondary-button" onClick={waitForCall} type="button">
            <Waves size={17} />
            等待呼叫
          </button>
          <button className="primary-button" onClick={joinRoom} type="button">
            <DoorOpen size={17} />
            主动加入
          </button>
          <button
            className="danger-button"
            disabled={sessionState === "idle"}
            onClick={hangUp}
            type="button"
          >
            <PhoneOff size={17} />
            挂断
          </button>
        </div>
      </header>

      <section className="receiver-form panel">
        <label>
          示教端地址 / 服务器地址
          <input
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            placeholder="http://127.0.0.1:7880"
          />
        </label>
        <label>
          房间号
          <input
            value={roomCode}
            onChange={(event) => setRoomCode(event.target.value)}
            placeholder="ST-ABC123"
          />
        </label>
        <div className="session-state">
          <span
            className={`status-dot ${sessionState === "idle" ? "" : "ok"}`}
          />
          {sessionState === "waiting"
            ? "等待发起端呼叫"
            : sessionState === "joined-local"
              ? "本地加入状态，实时音视频待接入"
              : "未加入房间"}
        </div>
      </section>

      <section className="preview-grid receiver-preview">
        <VideoPane
          emptyText="等待远端主画面"
          isPrimary
          title="远端主画面"
          variant="receiver"
        />
        <VideoPane
          emptyText="等待远端辅画面"
          title="远端辅画面"
          variant="receiver"
        />
      </section>

      <section className="panel">
        <div className="section-heading">
          <h2>最近连接</h2>
          <span>{config.recentConnections.length}</span>
        </div>
        <div className="recent-list">
          {config.recentConnections.length === 0 && (
            <div className="empty-state">暂无连接记录</div>
          )}
          {config.recentConnections.map((recent) => (
            <button
              className="recent-item"
              key={recent.id}
              onClick={() => loadRecent(recent)}
              type="button"
            >
              <div>
                <strong>{recent.label}</strong>
                <span>{recent.endpoint}</span>
              </div>
              <Save size={17} />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function upsertRecent(
  current: RecentConnection[],
  next: RecentConnection,
): RecentConnection[] {
  const filtered = current.filter(
    (item) => item.endpoint !== next.endpoint || item.roomCode !== next.roomCode,
  );
  return [next, ...filtered].slice(0, 8);
}
