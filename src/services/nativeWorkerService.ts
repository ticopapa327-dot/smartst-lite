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
  launchMode: string;
  workspaceRoot: string;
  manifestPath: string;
  executablePath: string;
  packagedExecutablePath: string;
  manifestExists: boolean;
  executableExists: boolean;
  packagedExecutableExists: boolean;
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

export interface NativeWorkerSessionSnapshot {
  state?: string;
  captureSession?: {
    state?: string;
    boundVideoChannels?: number;
    boundAudioEndpoints?: number;
    continuousVideoThreadCount?: number;
  };
  channels?: unknown[];
  stats?: {
    framesProduced?: number;
    audioPacketsProduced?: number;
    audioPayloadCopyCount?: number;
    audioPayloadCopyErrorCount?: number;
    audioPayloadQueueBytes?: number;
    audioPayloadTotalCopiedBytes?: number;
    audioPayloadConsumeCount?: number;
    audioPayloadConsumedBytes?: number;
    videoFrameQueuePushCount?: number;
    videoFrameQueueDropCount?: number;
    videoPayloadCopyCount?: number;
    videoPayloadCopyErrorCount?: number;
    videoPayloadQueueBytes?: number;
    videoPayloadTotalCopiedBytes?: number;
    videoPayloadConsumeCount?: number;
    videoPayloadConsumedBytes?: number;
    realMediaSession?: boolean;
  };
}

export interface NativeWorkerStartParams {
  channels?: string[];
  videoMediaTypeIndex?: number;
  audioIndex?: number;
  startVideoThread?: boolean;
  startAudioThread?: boolean;
  videoFrameQueueCapacity?: number;
  audioPayloadQueueCapacity?: number;
}

export interface NativeWorkerPayloadConsumeParams {
  channelId?: string;
  maxFrames?: number;
  maxPackets?: number;
}

export interface NativeWorkerPayloadConsumeResult {
  status?: "consumed" | "empty" | "desktop-only";
  channelId?: string;
  consumer?: string;
  payloadTransport?: string;
  exportedOverJson?: boolean;
  maxFrames?: number;
  maxPackets?: number;
  consumedFrames?: number;
  consumedPackets?: number;
  consumedBytes?: number;
  remainingDepth?: number;
  remainingBytes?: number;
  latestSequence?: number | null;
}

export async function getNativeWorkerReadiness(): Promise<NativeWorkerReadiness> {
  if (!isTauriRuntime()) {
    return {
      status: "desktop-only",
      launchMode: "desktop-only",
      workspaceRoot: "",
      manifestPath: "",
      executablePath: "",
      packagedExecutablePath: "",
      manifestExists: false,
      executableExists: false,
      packagedExecutableExists: false,
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
      launchMode: "error",
      workspaceRoot: "",
      manifestPath: "",
      executablePath: "",
      packagedExecutablePath: "",
      manifestExists: false,
      executableExists: false,
      packagedExecutableExists: false,
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

export async function startNativeWorkerSession(
  params?: NativeWorkerStartParams,
): Promise<NativeWorkerSessionSnapshot> {
  if (!isTauriRuntime()) {
    return idleNativeWorkerSession();
  }

  return invoke<NativeWorkerSessionSnapshot>("start_native_worker_session", {
    params: params ?? null,
  });
}

export async function getNativeWorkerSessionStatus(): Promise<NativeWorkerSessionSnapshot> {
  if (!isTauriRuntime()) {
    return idleNativeWorkerSession();
  }

  return invoke<NativeWorkerSessionSnapshot>("get_native_worker_session_status");
}

export async function stopNativeWorkerSession(): Promise<NativeWorkerSessionSnapshot> {
  if (!isTauriRuntime()) {
    return idleNativeWorkerSession();
  }

  return invoke<NativeWorkerSessionSnapshot>("stop_native_worker_session");
}

export async function consumeNativeWorkerVideoPayloadQueue(
  params?: NativeWorkerPayloadConsumeParams,
): Promise<NativeWorkerPayloadConsumeResult> {
  if (!isTauriRuntime()) {
    return {
      status: "desktop-only",
      payloadTransport: "native-only",
      exportedOverJson: false,
      maxFrames: params?.maxFrames ?? 0,
      consumedFrames: 0,
      consumedBytes: 0,
      remainingDepth: 0,
      remainingBytes: 0,
      latestSequence: null,
    };
  }

  return invoke<NativeWorkerPayloadConsumeResult>("consume_native_worker_video_payload_queue", {
    params: params ?? null,
  });
}

export async function consumeNativeWorkerAudioPayloadQueue(
  params?: NativeWorkerPayloadConsumeParams,
): Promise<NativeWorkerPayloadConsumeResult> {
  if (!isTauriRuntime()) {
    return {
      status: "desktop-only",
      payloadTransport: "native-only",
      exportedOverJson: false,
      maxPackets: params?.maxPackets ?? 0,
      consumedPackets: 0,
      consumedBytes: 0,
      remainingDepth: 0,
      remainingBytes: 0,
      latestSequence: null,
    };
  }

  return invoke<NativeWorkerPayloadConsumeResult>("consume_native_worker_audio_payload_queue", {
    params: params ?? null,
  });
}

function idleNativeWorkerSession(): NativeWorkerSessionSnapshot {
  return {
    state: "idle",
    captureSession: {
      state: "idle",
      boundVideoChannels: 0,
      boundAudioEndpoints: 0,
      continuousVideoThreadCount: 0,
    },
    channels: [],
    stats: {
      framesProduced: 0,
      audioPacketsProduced: 0,
      audioPayloadCopyCount: 0,
      audioPayloadCopyErrorCount: 0,
      audioPayloadQueueBytes: 0,
      audioPayloadTotalCopiedBytes: 0,
      audioPayloadConsumeCount: 0,
      audioPayloadConsumedBytes: 0,
      videoFrameQueuePushCount: 0,
      videoFrameQueueDropCount: 0,
      videoPayloadCopyCount: 0,
      videoPayloadCopyErrorCount: 0,
      videoPayloadQueueBytes: 0,
      videoPayloadTotalCopiedBytes: 0,
      videoPayloadConsumeCount: 0,
      videoPayloadConsumedBytes: 0,
      realMediaSession: false,
    },
  };
}
