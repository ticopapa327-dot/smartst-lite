import {
  LayoutDashboard,
  Laptop,
  RadioTower,
  ShieldCheck,
  Sparkles,
  Video,
} from "lucide-react";
import type { AppView } from "../domain/types";

interface StartupPageProps {
  onChooseMode: (view: AppView) => void;
}

const highlights = [
  { label: "USB 采集优先", icon: Sparkles },
  { label: "4 路本地预览", icon: Video },
  { label: "LiveKit 预留", icon: RadioTower },
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
          <h1>视捷UST</h1>
          <p>
            面向手术室本地预览、远程示教互动和录像管理的 Windows 桌面客户端。
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
          className="mode-tile workbench"
          onClick={() => onChooseMode("workbench")}
          type="button"
        >
          <LayoutDashboard size={32} />
          <span>手术室工作台</span>
          <small>USB 采集、默认画面、呼叫策略</small>
        </button>
      </section>
    </div>
  );
}
