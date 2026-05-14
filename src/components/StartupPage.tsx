import {
  MonitorPlay,
  RadioTower,
  ShieldCheck,
  Sparkles,
  Video,
  Laptop,
} from "lucide-react";
import type { AppView } from "../domain/types";

interface StartupPageProps {
  onChooseMode: (view: AppView) => void;
}

const highlights = [
  { label: "免费手术示教", icon: Sparkles },
  { label: "2 路摄像机", icon: Video },
  { label: "快速转播", icon: RadioTower },
  { label: "Windows 可用", icon: Laptop },
];

export function StartupPage({ onChooseMode }: StartupPageProps) {
  return (
    <div className="startup-page">
      <section className="launch-hero">
        <div className="hero-copy">
          <div className="eyebrow">
            <ShieldCheck size={17} />
            轻量级手术示教 / 转播客户端
          </div>
          <h1>SmartST Lite</h1>
          <p>
            面向医美医院、动物医院和民营医疗机构的免费 Windows 手术转播工具。
          </p>
          <div className="highlight-row">
            {highlights.map((item) => {
              const Icon = item.icon;
              return (
                <span className="highlight-chip" key={item.label}>
                  <Icon size={16} />
                  {item.label}
                </span>
              );
            })}
          </div>
        </div>

        <div className="launch-visual" aria-hidden="true">
          <div className="visual-screen main-feed">
            <div className="feed-label">CAM 01</div>
            <div className="scan-line" />
          </div>
          <div className="visual-screen side-feed">
            <div className="feed-label">CAM 02</div>
          </div>
          <div className="visual-footer">
            <span />
            <span />
            <span />
          </div>
        </div>
      </section>

      <section className="mode-grid" aria-label="选择工作模式">
        <button
          className="mode-tile initiator"
          onClick={() => onChooseMode("initiator")}
          type="button"
        >
          <RadioTower size={32} />
          <span>示教发起端</span>
          <small>手术室、操作间</small>
        </button>

        <button
          className="mode-tile receiver"
          onClick={() => onChooseMode("receiver")}
          type="button"
        >
          <MonitorPlay size={32} />
          <span>示教接收端</span>
          <small>示教室、办公室、专家端</small>
        </button>
      </section>
    </div>
  );
}
