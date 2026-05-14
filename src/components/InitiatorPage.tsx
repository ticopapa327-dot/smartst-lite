import { useMemo, useState } from "react";
import {
  Mic,
  Pencil,
  PhoneCall,
  Plus,
  RadioTower,
  RefreshCcw,
  Trash2,
  Users,
} from "lucide-react";
import type { AppConfig, CameraConfig, RoomSession } from "../domain/types";
import { MAX_CAMERAS } from "../services/cameraService";
import { createLocalRoom, markCalling } from "../services/realtimeService";
import { CameraDialog } from "./CameraDialog";
import { VideoPane } from "./VideoPane";

interface InitiatorPageProps {
  config: AppConfig;
  onConfigChange: (updater: (current: AppConfig) => AppConfig) => void;
  onLog: (
    level: "info" | "warn" | "error",
    message: string,
    context?: Record<string, unknown>,
  ) => void;
}

export function InitiatorPage({
  config,
  onConfigChange,
  onLog,
}: InitiatorPageProps) {
  const [dialogCamera, setDialogCamera] = useState<CameraConfig | undefined>();
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const primaryCamera = useMemo(
    () => config.cameras.find((camera) => camera.role === "primary"),
    [config.cameras],
  );
  const secondaryCamera = useMemo(
    () => config.cameras.find((camera) => camera.role === "secondary"),
    [config.cameras],
  );

  function handleSaveCamera(camera: CameraConfig) {
    onConfigChange((current) => {
      const exists = current.cameras.some((item) => item.id === camera.id);
      const cameras = exists
        ? current.cameras.map((item) => (item.id === camera.id ? camera : item))
        : [...current.cameras, camera].slice(0, MAX_CAMERAS);

      return {
        ...current,
        cameras: normalizeCameraRoles(cameras),
      };
    });
    setIsDialogOpen(false);
    setDialogCamera(undefined);
    onLog("info", "Camera configuration saved", {
      cameraName: camera.name,
      ipAddress: camera.ipAddress,
    });
  }

  function removeCamera(cameraId: string) {
    onConfigChange((current) => ({
      ...current,
      cameras: normalizeCameraRoles(
        current.cameras.filter((camera) => camera.id !== cameraId),
      ),
    }));
    onLog("warn", "Camera configuration removed", { cameraId });
  }

  function makePrimary(cameraId: string) {
    onConfigChange((current) => ({
      ...current,
      cameras: current.cameras.map((camera) => ({
        ...camera,
        role: camera.id === cameraId ? "primary" : "secondary",
      })),
    }));
    onLog("info", "Primary camera changed", { cameraId });
  }

  function createRoom() {
    const room = createLocalRoom();
    onConfigChange((current) => ({
      ...current,
      roomSession: room,
    }));
    onLog("info", "Local teaching room created", { roomCode: room.roomCode });
  }

  function callReceiver() {
    if (!config.roomSession.roomCode) {
      createRoom();
      return;
    }

    const nextRoom = markCalling(config.roomSession);
    onConfigChange((current) => ({
      ...current,
      roomSession: nextRoom,
    }));
    onLog("warn", "Call receiver requested but signaling is TODO", {
      roomCode: nextRoom.roomCode,
    });
  }

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <div className="eyebrow">
            <RadioTower size={17} />
            示教发起端
          </div>
          <h1>手术室转播控制台</h1>
        </div>
        <div className="header-actions">
          <button className="secondary-button" disabled title="ONVIF 自动发现 TODO" type="button">
            <RefreshCcw size={17} />
            自动发现
          </button>
          <button
            className="primary-button"
            disabled={config.cameras.length >= MAX_CAMERAS}
            onClick={() => {
              setDialogCamera(undefined);
              setIsDialogOpen(true);
            }}
            type="button"
          >
            <Plus size={17} />
            添加摄像机
          </button>
        </div>
      </header>

      <section className="control-band">
        <div className="room-panel">
          <span className={`status-dot ${config.roomSession.status === "idle" ? "" : "ok"}`} />
          <div>
            <strong>{config.roomSession.roomCode || "未创建房间"}</strong>
            <small>{roomStatusText(config.roomSession)}</small>
          </div>
        </div>
        <div className="control-actions">
          <button className="secondary-button" disabled title="麦克风采集 TODO" type="button">
            <Mic size={17} />
            麦克风
          </button>
          <button className="secondary-button" onClick={createRoom} type="button">
            <Users size={17} />
            创建房间
          </button>
          <button className="primary-button" onClick={callReceiver} type="button">
            <PhoneCall size={17} />
            呼叫接收端
          </button>
        </div>
      </section>

      <section className="two-column-layout">
        <div className="panel">
          <div className="section-heading">
            <h2>摄像机列表</h2>
            <span>{config.cameras.length}/{MAX_CAMERAS}</span>
          </div>

          <div className="camera-list">
            {config.cameras.length === 0 && (
              <div className="empty-state">暂无摄像机配置</div>
            )}
            {config.cameras.map((camera) => (
              <article className="camera-card" key={camera.id}>
                <div>
                  <div className="camera-title">
                    <strong>{camera.name}</strong>
                    <span className={`role-tag ${camera.role}`}>
                      {camera.role === "primary" ? "主画面" : "辅画面"}
                    </span>
                  </div>
                  <p>{camera.ipAddress}:{camera.onvifPort}</p>
                  <code>{camera.rtspUrl}</code>
                </div>
                <div className="card-actions">
                  <button
                    className="icon-button"
                    onClick={() => makePrimary(camera.id)}
                    title="设为主画面"
                    type="button"
                  >
                    <RadioTower size={17} />
                  </button>
                  <button
                    className="icon-button"
                    onClick={() => {
                      setDialogCamera(camera);
                      setIsDialogOpen(true);
                    }}
                    title="编辑摄像机"
                    type="button"
                  >
                    <Pencil size={17} />
                  </button>
                  <button
                    className="icon-button danger"
                    onClick={() => removeCamera(camera.id)}
                    title="删除摄像机"
                    type="button"
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>

        <div className="preview-grid">
          <VideoPane
            camera={primaryCamera}
            isPrimary
            title="主画面"
            onMakePrimary={primaryCamera ? undefined : undefined}
          />
          <VideoPane
            camera={secondaryCamera}
            title="辅画面"
            onMakePrimary={
              secondaryCamera ? () => makePrimary(secondaryCamera.id) : undefined
            }
          />
        </div>
      </section>

      {isDialogOpen && (
        <CameraDialog
          camera={dialogCamera}
          cameraIndex={config.cameras.length}
          onClose={() => {
            setIsDialogOpen(false);
            setDialogCamera(undefined);
          }}
          onSave={handleSaveCamera}
        />
      )}
    </div>
  );
}

function normalizeCameraRoles(cameras: CameraConfig[]): CameraConfig[] {
  return cameras.slice(0, MAX_CAMERAS).map((camera, index) => ({
    ...camera,
    role: index === 0 ? "primary" : "secondary",
  }));
}

function roomStatusText(room: RoomSession): string {
  if (room.status === "created") {
    return room.message ?? "房间已创建";
  }

  if (room.status === "calling") {
    return room.message ?? "正在呼叫接收端";
  }

  if (room.status === "connected") {
    return "已连接";
  }

  return "等待创建示教房间";
}
