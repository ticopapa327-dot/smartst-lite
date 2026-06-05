import { Activity, Monitor, RadioTower, Video } from "lucide-react";
import type { VideoChannel } from "../domain/mediaTypes";

interface ChannelGridProps {
  channels: VideoChannel[];
}

const roleLabels: Record<VideoChannel["role"], string> = {
  field: "术野",
  panorama: "全景",
  endoscope: "内镜",
  device: "医疗设备",
  auxiliary: "辅助",
};

export function ChannelGrid({ channels }: ChannelGridProps) {
  return (
    <section className="hmi-panel">
      <div className="hmi-section-heading">
        <div>
          <span>Local Preview</span>
          <h2>本地视频通道</h2>
        </div>
        <strong>{channels.length} 路</strong>
      </div>

      <div className="channel-grid">
        {channels.map((channel) => (
          <article
            className={`channel-card ${channel.remoteDefault ? "remote-default" : ""}`}
            key={channel.id}
          >
            <div className="channel-screen" aria-hidden="true">
              <Video size={34} />
              <span>{channel.displayName}</span>
            </div>
            <div className="channel-footer">
              <div>
                <strong>{roleLabels[channel.role]}</strong>
                <span>{channel.preferredWidth ?? 1920}x{channel.preferredHeight ?? 1080} / {channel.preferredFrameRate ?? 30}fps</span>
              </div>
              <div className="channel-badges">
                {channel.localPrimary && (
                  <span className="hmi-badge active">
                    <Monitor size={12} />
                    主
                  </span>
                )}
                {channel.remoteDefault && (
                  <span className="hmi-badge accent">
                    <RadioTower size={12} />
                    远端默认
                  </span>
                )}
                <span className={`hmi-badge ${channel.healthy ? "ok" : "muted"}`}>
                  <Activity size={12} />
                  {channel.healthy ? "正常" : "待检测"}
                </span>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

