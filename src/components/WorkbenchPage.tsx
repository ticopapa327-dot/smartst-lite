import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { VideoChannel } from "../domain/mediaTypes";
import {
  getNativeWorkerReadiness,
  probeNativeWorkerDevices,
  type NativeWorkerDeviceProbe,
  type NativeWorkerReadiness,
  type NativeWorkerVideoChannelBindings,
} from "../services/nativeWorkerService";
import type { LiveKitConnectionDraft } from "../services/livekitRoomService";
import { CallPanel } from "./CallPanel";
import { ChannelGrid } from "./ChannelGrid";
import { NativeWorkerPanel } from "./NativeWorkerPanel";
import { RecordingPanel } from "./RecordingPanel";
import { UsbVideoConfigPanel } from "./UsbVideoConfigPanel";

interface WorkbenchPageProps {
  organizationName: string;
  usbVideoChannelBindings: NativeWorkerVideoChannelBindings;
  onUsbVideoChannelBindingsChange: (
    bindings: NativeWorkerVideoChannelBindings,
  ) => void;
}

const defaultChannels: VideoChannel[] = [
  {
    id: "panorama",
    displayName: "全景摄像机",
    role: "panorama",
    kind: "usb",
    enabled: true,
    healthy: false,
    health: "unknown",
    localPrimary: false,
    remoteDefault: false,
    priority: 20,
    preferredWidth: 1920,
    preferredHeight: 1080,
    preferredFrameRate: 30,
  },
  {
    id: "field-camera",
    displayName: "术野摄像机",
    role: "field",
    kind: "usb",
    enabled: true,
    healthy: false,
    health: "unknown",
    localPrimary: true,
    remoteDefault: true,
    priority: 10,
    preferredWidth: 1920,
    preferredHeight: 1080,
    preferredFrameRate: 30,
  },
  {
    id: "endoscope",
    displayName: "腹腔镜 / 内镜",
    role: "endoscope",
    kind: "usb",
    enabled: true,
    healthy: false,
    health: "unknown",
    localPrimary: false,
    remoteDefault: false,
    priority: 30,
    preferredWidth: 1920,
    preferredHeight: 1080,
    preferredFrameRate: 30,
  },
  {
    id: "aux-device",
    displayName: "辅助医疗设备",
    role: "device",
    kind: "usb",
    enabled: true,
    healthy: false,
    health: "unknown",
    localPrimary: false,
    remoteDefault: false,
    priority: 40,
    preferredWidth: 1920,
    preferredHeight: 1080,
    preferredFrameRate: 30,
  },
];

const LiveKitPocPanel = lazy(() =>
  import("./LiveKitPocPanel").then((module) => ({
    default: module.LiveKitPocPanel,
  })),
);

export function WorkbenchPage({
  organizationName,
  usbVideoChannelBindings,
  onUsbVideoChannelBindingsChange,
}: WorkbenchPageProps) {
  const [nativeReadiness, setNativeReadiness] =
    useState<NativeWorkerReadiness | null>(null);
  const [deviceProbe, setDeviceProbe] = useState<NativeWorkerDeviceProbe | null>(
    null,
  );
  const [isDeviceProbeRunning, setIsDeviceProbeRunning] = useState(false);
  const [deviceProbeError, setDeviceProbeError] = useState<string | null>(null);
  const [liveKitDraft, setLiveKitDraft] =
    useState<LiveKitConnectionDraft | undefined>();
  const videoDevices = deviceProbe?.devices?.video ?? [];
  const defaultChannel =
    defaultChannels.find((channel) => channel.localPrimary) ??
    defaultChannels.find((channel) => channel.remoteDefault) ??
    [...defaultChannels].sort((left, right) => left.priority - right.priority)[0];

  const runDeviceProbe = useCallback(async () => {
    setIsDeviceProbeRunning(true);
    setDeviceProbeError(null);
    try {
      const nextProbe = await probeNativeWorkerDevices();
      setDeviceProbe(nextProbe);
      if (nextProbe.status === "error" || nextProbe.status === "unavailable") {
        setDeviceProbeError(nextProbe.message);
      }
    } catch (error) {
      setDeviceProbeError(errorMessage(error));
    } finally {
      setIsDeviceProbeRunning(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    getNativeWorkerReadiness().then((readiness) => {
      if (!cancelled) {
        setNativeReadiness(readiness);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (nativeReadiness?.status === "ready") {
      void runDeviceProbe();
    }
  }, [nativeReadiness?.status, runDeviceProbe]);

  return (
    <div className="hmi-workbench">
      <header className="workbench-header">
        <div>
          <div className="hmi-eyebrow">
            <ShieldCheck size={17} />
            USB-first Surgery Teaching Workbench
          </div>
          <h1>手术室工作台</h1>
          <p>
            {organizationName} · 当前为 USB-first / LiveKit / Native Worker
            PoC，真实交付仍需现场硬件验收。
          </p>
        </div>
        <div className="workbench-status-stack">
          <div className="workbench-status">
            <span className="hmi-status-dot warn" />
            PoC 骨架
          </div>
          <div className="workbench-status">
            <span
              className={`hmi-status-dot ${nativeWorkerStatusDot(nativeReadiness)}`}
            />
            {nativeWorkerStatusLabel(nativeReadiness)}
          </div>
        </div>
      </header>

      <UsbVideoConfigPanel
        channels={defaultChannels}
        videoDevices={videoDevices}
        bindings={usbVideoChannelBindings}
        isProbing={isDeviceProbeRunning}
        probeMessage={deviceProbe?.message}
        probeError={deviceProbeError}
        onProbeDevices={runDeviceProbe}
        onBindingsChange={onUsbVideoChannelBindingsChange}
      />

      <ChannelGrid channels={defaultChannels} />

      <div className="workbench-two-column">
        <CallPanel
          defaultChannel={defaultChannel}
          onLiveKitDraft={setLiveKitDraft}
        />
        <Suspense fallback={<LiveKitPocPanelFallback />}>
          <LiveKitPocPanel connectionDraft={liveKitDraft} />
        </Suspense>
        <NativeWorkerPanel
          channels={defaultChannels}
          deviceProbe={deviceProbe}
          videoChannelBindings={usbVideoChannelBindings}
          onDeviceProbe={setDeviceProbe}
        />
        <RecordingPanel channels={defaultChannels} />
      </div>
    </div>
  );
}

function LiveKitPocPanelFallback() {
  return (
    <section className="hmi-panel livekit-poc-panel">
      <div className="hmi-section-heading">
        <div>
          <span>LiveKit PoC</span>
          <h2>加载中</h2>
        </div>
        <strong>Loading</strong>
      </div>
    </section>
  );
}

function nativeWorkerStatusLabel(readiness: NativeWorkerReadiness | null): string {
  if (!readiness) return "Native Worker checking";
  if (readiness.status === "ready") return "Native Worker ready";
  if (readiness.status === "source-only") return "Native Worker source-only";
  if (readiness.status === "desktop-only") return "Native Worker desktop-only";
  if (readiness.status === "missing") return "Native Worker missing";
  return "Native Worker error";
}

function nativeWorkerStatusDot(readiness: NativeWorkerReadiness | null): string {
  if (!readiness) return "warn";
  if (readiness.status === "ready") return "ok";
  if (readiness.status === "source-only" || readiness.status === "desktop-only") {
    return "warn";
  }
  return "error";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
