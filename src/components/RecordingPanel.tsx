import { Database, Download, HardDrive, RadioTower } from "lucide-react";
import type { VideoChannel } from "../domain/mediaTypes";

interface RecordingPanelProps {
  channels: VideoChannel[];
}

export function RecordingPanel({ channels }: RecordingPanelProps) {
  const selectedChannels = channels.filter((channel) => channel.enabled);

  return (
    <section className="hmi-panel recording-panel">
      <div className="hmi-section-heading">
        <div>
          <span>Recording</span>
          <h2>录像与文件</h2>
        </div>
        <strong>{selectedChannels.length} 路待选</strong>
      </div>

      <div className="recording-grid">
        <div className="recording-stat">
          <HardDrive size={18} />
          <strong>本地存储</strong>
          <span>Native Worker 写入 MP4 / manifest</span>
        </div>
        <div className="recording-stat">
          <Database size={18} />
          <strong>患者绑定</strong>
          <span>HIS adapter 后续接入</span>
        </div>
        <div className="recording-stat">
          <Download size={18} />
          <strong>导出上传</strong>
          <span>移动存储与 FTP/SFTP 预留</span>
        </div>
        <div className="recording-stat">
          <RadioTower size={18} />
          <strong>AI 接口</strong>
          <span>仅预留异步 job</span>
        </div>
      </div>

      <div className="hmi-action-row">
        <button className="hmi-button danger" disabled type="button">
          开始录像
        </button>
        <button className="hmi-button" disabled type="button">
          打开录像列表
        </button>
      </div>
    </section>
  );
}

