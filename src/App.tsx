import { useCallback, useEffect, useState } from "react";
import type { AppConfig, AppView, DefaultPaths } from "./domain/types";
import { AppShell } from "./components/AppShell";
import { InitiatorPage } from "./components/InitiatorPage";
import { ReceiverPage } from "./components/ReceiverPage";
import { SettingsPage } from "./components/SettingsPage";
import { StartupPage } from "./components/StartupPage";
import { WorkbenchPage } from "./components/WorkbenchPage";
import {
  defaultConfig,
  getDefaultPaths,
  loadAppConfig,
  saveAppConfig,
} from "./services/configService";
import { writeLog } from "./services/logger";

export default function App() {
  const [activeView, setActiveView] = useState<AppView>("startup");
  const [config, setConfig] = useState<AppConfig>(defaultConfig);
  const [defaultPaths, setDefaultPaths] = useState<DefaultPaths>({
    configPath: "",
    logDirectory: "",
  });
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    async function bootstrap() {
      const [paths, storedConfig] = await Promise.all([
        getDefaultPaths(),
        loadAppConfig(),
      ]);
      setDefaultPaths(paths);
      setConfig({
        ...storedConfig,
        settings: {
          ...storedConfig.settings,
          logDirectory: storedConfig.settings.logDirectory || paths.logDirectory,
        },
      });
      setIsReady(true);
      await writeLog("info", "SmartST Lite started", undefined, {
        ...storedConfig.settings,
        logDirectory: storedConfig.settings.logDirectory || paths.logDirectory,
      });
    }

    void bootstrap();
  }, []);

  useEffect(() => {
    if (!isReady) {
      return;
    }

    void saveAppConfig(config);
  }, [config, isReady]);

  const changeConfig = useCallback(
    (updater: (current: AppConfig) => AppConfig) => {
      setConfig((current) => updater(current));
    },
    [],
  );

  const log = useCallback(
    (
      level: "info" | "warn" | "error",
      message: string,
      context?: Record<string, unknown>,
    ) => {
      void writeLog(level, message, context, config.settings);
    },
    [config.settings],
  );

  return (
    <AppShell
      activeView={activeView}
      organizationName={config.settings.organizationName}
      onNavigate={setActiveView}
    >
      {!isReady && <div className="loading-view">正在加载本地配置...</div>}
      {isReady && activeView === "startup" && (
        <StartupPage onChooseMode={setActiveView} />
      )}
      {isReady && activeView === "workbench" && (
        <WorkbenchPage organizationName={config.settings.organizationName} />
      )}
      {isReady && activeView === "initiator" && (
        <InitiatorPage
          config={config}
          onConfigChange={changeConfig}
          onLog={log}
        />
      )}
      {isReady && activeView === "receiver" && (
        <ReceiverPage
          config={config}
          onConfigChange={changeConfig}
          onLog={log}
        />
      )}
      {isReady && activeView === "settings" && (
        <SettingsPage
          config={config}
          defaultPaths={defaultPaths}
          onConfigChange={changeConfig}
          onLog={log}
        />
      )}
    </AppShell>
  );
}
