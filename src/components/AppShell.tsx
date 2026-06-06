import {
  Clapperboard,
  LayoutDashboard,
  type LucideIcon,
  Settings,
  Stethoscope,
} from "lucide-react";
import type { ReactNode } from "react";
import type { AppView } from "../domain/types";

interface AppShellProps {
  activeView: AppView;
  organizationName: string;
  onNavigate: (view: AppView) => void;
  children: ReactNode;
}

const navItems: Array<{
  view: AppView;
  label: string;
  title: string;
  icon: LucideIcon;
}> = [
  {
    view: "startup",
    label: "首页",
    title: "返回启动页",
    icon: Stethoscope,
  },
  {
    view: "workbench",
    label: "手术室工作台",
    title: "进入 USB-first 手术室工作台",
    icon: LayoutDashboard,
  },
  {
    view: "settings",
    label: "设置",
    title: "打开系统设置",
    icon: Settings,
  },
];

export function AppShell({
  activeView,
  organizationName,
  onNavigate,
  children,
}: AppShellProps) {
  return (
    <div className="app-frame">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            <Clapperboard size={24} />
          </div>
          <div>
            <div className="brand-name">视捷UST</div>
            <div className="brand-subtitle">{organizationName}</div>
          </div>
        </div>

        <nav className="nav-list" aria-label="主导航">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={`nav-item ${activeView === item.view ? "active" : ""}`}
                key={item.view}
                onClick={() => onNavigate(item.view)}
                title={item.title}
                type="button"
              >
                <Icon size={19} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-note">
          <span className="status-dot ok" />
          本地配置已启用
        </div>
      </aside>
      <main className="workspace">{children}</main>
    </div>
  );
}
