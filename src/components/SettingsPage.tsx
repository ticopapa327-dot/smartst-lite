import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { FolderOpen, Save, Settings } from "lucide-react";
import type { AppConfig, AppSettings, DefaultPaths } from "../domain/types";

interface SettingsPageProps {
  config: AppConfig;
  defaultPaths: DefaultPaths;
  onConfigChange: (updater: (current: AppConfig) => AppConfig) => void;
  onLog: (
    level: "info" | "warn" | "error",
    message: string,
    context?: Record<string, unknown>,
  ) => void;
}

export function SettingsPage({
  config,
  defaultPaths,
  onConfigChange,
  onLog,
}: SettingsPageProps) {
  const [draft, setDraft] = useState<AppSettings>(config.settings);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(config.settings);
  }, [config.settings]);

  function updateField<K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onConfigChange((current) => ({
      ...current,
      settings: draft,
    }));
    setSaved(true);
    onLog("info", "Settings saved", {
      serverUrl: draft.serverUrl,
      organizationName: draft.organizationName,
      deviceName: draft.deviceName,
      logDirectory: draft.logDirectory,
    });
  }

  return (
    <div className="page-stack settings-page">
      <header className="page-header">
        <div>
          <div className="eyebrow">
            <Settings size={17} />
            设置
          </div>
          <h1>本机参数</h1>
        </div>
      </header>

      <form className="settings-form panel" onSubmit={saveSettings}>
        <label>
          服务器地址
          <input
            value={draft.serverUrl}
            onChange={(event) => updateField("serverUrl", event.target.value)}
            placeholder="http://127.0.0.1:7880"
          />
        </label>

        <label>
          机构名称
          <input
            value={draft.organizationName}
            onChange={(event) =>
              updateField("organizationName", event.target.value)
            }
            placeholder="机构名称"
          />
        </label>

        <label>
          设备名称
          <input
            value={draft.deviceName}
            onChange={(event) => updateField("deviceName", event.target.value)}
            placeholder="示教端 / 接收端"
          />
        </label>

        <label>
          日志目录
          <div className="input-with-button">
            <input
              value={draft.logDirectory}
              onChange={(event) =>
                updateField("logDirectory", event.target.value)
              }
              placeholder={defaultPaths.logDirectory}
            />
            <button
              className="icon-button"
              disabled
              title="目录选择器 TODO"
              type="button"
            >
              <FolderOpen size={17} />
            </button>
          </div>
        </label>

        <div className="path-note">
          <strong>配置文件</strong>
          <code>{defaultPaths.configPath}</code>
        </div>

        <div className="form-footer">
          {saved && <span className="save-hint">已保存</span>}
          <button className="primary-button" type="submit">
            <Save size={17} />
            保存设置
          </button>
        </div>
      </form>

      <section className="panel roadmap-teaser">
        <h2>高级版入口</h2>
        <p>
          多房间调度、病例归档、权限管理、HIS/PACS 对接和集中运维暂不在 Lite MVP 范围内。
        </p>
        <button className="secondary-button" disabled type="button">
          暂未开放
        </button>
      </section>
    </div>
  );
}
