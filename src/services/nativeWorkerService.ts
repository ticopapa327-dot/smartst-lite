import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./configService";

export type NativeWorkerReadinessStatus =
  | "ready"
  | "source-only"
  | "missing"
  | "desktop-only"
  | "error";

export interface NativeWorkerReadiness {
  status: NativeWorkerReadinessStatus;
  workspaceRoot: string;
  manifestPath: string;
  executablePath: string;
  manifestExists: boolean;
  executableExists: boolean;
  cargoAvailable: boolean;
  cargoVersion: string | null;
  message: string;
}

export interface NativeWorkerDeviceProbe {
  status: "ok" | "unavailable" | "desktop-only" | "error";
  readiness: NativeWorkerReadiness;
  devices: unknown;
  message: string;
}

export async function getNativeWorkerReadiness(): Promise<NativeWorkerReadiness> {
  if (!isTauriRuntime()) {
    return {
      status: "desktop-only",
      workspaceRoot: "",
      manifestPath: "",
      executablePath: "",
      manifestExists: false,
      executableExists: false,
      cargoAvailable: false,
      cargoVersion: null,
      message: "Native Worker readiness is only available in the Windows desktop runtime.",
    };
  }

  try {
    return await invoke<NativeWorkerReadiness>("get_native_worker_readiness");
  } catch (error) {
    return {
      status: "error",
      workspaceRoot: "",
      manifestPath: "",
      executablePath: "",
      manifestExists: false,
      executableExists: false,
      cargoAvailable: false,
      cargoVersion: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function probeNativeWorkerDevices(): Promise<NativeWorkerDeviceProbe> {
  const readiness = await getNativeWorkerReadiness();
  if (!isTauriRuntime()) {
    return {
      status: "desktop-only",
      readiness,
      devices: null,
      message: "Native Worker device probing is only available in the Windows desktop runtime.",
    };
  }

  try {
    return await invoke<NativeWorkerDeviceProbe>("probe_native_worker_devices");
  } catch (error) {
    return {
      status: "error",
      readiness,
      devices: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
