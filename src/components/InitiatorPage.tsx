import { useMemo, useState } from "react";
import {
  AlertCircle,
  Mic,
  Pencil,
  PhoneCall,
  Plus,
  RadioTower,
  RefreshCcw,
  Trash2,
  Users,
} from "lucide-react";
import type {
  AppConfig,
  CameraConfig,
  DiscoveredOnvifCamera,
  RoomSession,
} from "../domain/types";
import {
  type CameraDraft,
  MAX_CAMERAS,
  discoverOnvifCameras,
  draftFromDiscoveredCamera,
} from "../services/cameraService";
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
  const [initialDraft, setInitialDraft] = useState<
    Partial<CameraDraft> | undefined
  >();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [discoveredCameras, setDiscoveredCameras] = useState<
    DiscoveredOnvifCamera[]
  >([]);
  const [discoveryMessage, setDiscoveryMessage] = useState("");
  const [discoveryError, setDiscoveryError] = useState("");

  const primaryCamera = useMemo(
    () => config.cameras.find((camera) => camera.role === "primary"),
    [config.cameras],
  );
  const secondaryCamera = useMemo(
    () => config.cameras.find((camera) => camera.role === "secondary"),
    [config.cameras],
  );
  const configuredIpAddresses = useMemo(
    () => new Set(config.cameras.map((camera) => camera.ipAddress)),
    [config.cameras],
  );

  function openAddCamera(draft?: Partial<CameraDraft>) {
    setDialogCamera(undefined);
    setInitialDraft(draft);
    setIsDialogOpen(true);
  }

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
    setInitialDraft(undefined);
    onLog("info", "Camera configuration saved", {
      cameraName: camera.name,
      ipAddress: camera.ipAddress,
    });
  }

  async function handleDiscoverCameras() {
    if (config.cameras.length >= MAX_CAMERAS) {
      setDiscoveryError("当前已达到 2 路摄像机上限，无法继续添加。");
      return;
    }

    setIsDiscovering(true);
    setDiscoveryError("");
    setDiscoveryMessage("正在扫描局域网 ONVIF 摄像机，请稍候...");

    try {
      const cameras = await discoverOnvifCameras();
      setDiscoveredCameras(cameras);
      setDiscoveryMessage(
        cameras.length > 0
          ? `发现 ${cameras.length} 台 ONVIF 设备。请选择设备后补充用户名和密码。`
          : "没有发现 ONVIF 摄像机。请确认摄像机与本机在同一局域网，且 Windows 防火墙允许 UDP 3702。"
      );
      onLog("info", "ONVIF discovery completed", {
        count: cameras.length,
        cameras: cameras.map((camera) => ({
          name: camera.name,
          ipAddress: camera.ipAddress,
          xaddr: camera.xaddr,
        })),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "ONVIF 自动发现失败。";
      setDiscoveryError(message);
      setDiscoveryMessage("");
      onLog("error", "ONVIF discovery failed", { message });
    } finally {
      setIsDiscovering(false);
    }
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
          <button
            className="secondary-button"
            disabled={isDiscovering || config.cameras.length >= MAX_CAMERAS}
            onClick={handleDiscoverCameras}
            title={
              config.cameras.length >= MAX_CAMERAS
                ? "已达到 2 路摄像机上限"
                : "扫描局域网 ONVIF 摄像机"
            }
            type="button"
          >
            <RefreshCcw className={isDiscovering ? "spin" : ""} size={17} />
            {isDiscovering ? "发现中" : "自动发现"}
          </button>
          <button
            className="primary-button"
            disabled={config.cameras.length >= MAX_CAMERAS}
            onClick={() => openAddCamera()}
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
                      setInitialDraft(undefined);
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

          {(isDiscovering ||
            discoveryMessage ||
            discoveryError ||
            discoveredCameras.length > 0) && (
            <div className="discovery-block">
              <div className="section-heading compact">
                <h2>自动发现结果</h2>
                <span>{isDiscovering ? "扫描中" : `${discoveredCameras.length} 台`}</span>
              </div>

              {discoveryError && (
                <div className="form-error">{discoveryError}</div>
              )}
              {discoveryMessage && (
                <div className="discovery-message">
                  <AlertCircle size={17} />
                  <span>{discoveryMessage}</span>
                </div>
              )}

              <div className="discovery-list">
                {discoveredCameras.map((camera) => {
                  const alreadyAdded = configuredIpAddresses.has(
                    camera.ipAddress,
                  );
                  return (
                    <article className="discovery-card" key={camera.id}>
                      <div>
                        <div className="discovery-title">
                          <strong>{camera.name}</strong>
                          {alreadyAdded && <span className="role-tag primary">已添加</span>}
                        </div>
                        <p>
                          {camera.ipAddress}:{camera.onvifPort}
                        </p>
                        <code>{camera.xaddr}</code>
                      </div>
                      <button
                        className="secondary-button"
                        disabled={
                          alreadyAdded || config.cameras.length >= MAX_CAMERAS
                        }
                        onClick={() =>
                          openAddCamera(draftFromDiscoveredCamera(camera))
                        }
                        type="button"
                      >
                        使用此设备
                      </button>
                    </article>
                  );
                })}
              </div>
            </div>
          )}
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
          initialDraft={initialDraft}
          onClose={() => {
            setIsDialogOpen(false);
            setDialogCamera(undefined);
            setInitialDraft(undefined);
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
