import { ShieldCheck } from "lucide-react";
import type { VideoChannel } from "../domain/mediaTypes";
import { CallPanel } from "./CallPanel";
import { ChannelGrid } from "./ChannelGrid";
import { LiveKitPocPanel } from "./LiveKitPocPanel";
import { RecordingPanel } from "./RecordingPanel";

interface WorkbenchPageProps {
  organizationName: string;
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

export function WorkbenchPage({ organizationName }: WorkbenchPageProps) {
  const defaultChannel =
    defaultChannels.find((channel) => channel.remoteDefault) ??
    defaultChannels.find((channel) => channel.localPrimary);

  return (
    <div className="hmi-workbench">
      <header className="workbench-header">
        <div>
          <div className="hmi-eyebrow">
            <ShieldCheck size={17} />
            USB-first Surgery Teaching Workbench
          </div>
          <h1>手术室工作台</h1>
          <p>{organizationName} · 当前为 AD-04 LiveKit UI PoC，真实采集仍待 Native Media Worker 接入。</p>
        </div>
        <div className="workbench-status">
          <span className="hmi-status-dot warn" />
          PoC 骨架
        </div>
      </header>

      <ChannelGrid channels={defaultChannels} />

      <div className="workbench-two-column">
        <CallPanel defaultChannel={defaultChannel} />
        <LiveKitPocPanel />
        <RecordingPanel channels={defaultChannels} />
      </div>
    </div>
  );
}
