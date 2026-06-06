import { Activity, Cpu, Mic, RefreshCw, Video } from "lucide-react";
import { useState } from "react";
import {
  consumeNativeWorkerAudioPayloadQueue,
  consumeNativeWorkerVideoPayloadQueue,
  getNativeWorkerSessionStatus,
  probeNativeWorkerDevices,
  startNativeWorkerSession,
  stopNativeWorkerSession,
  type NativeWorkerDeviceProbe,
  type NativeWorkerPayloadConsumeResult,
  type NativeWorkerSessionSnapshot,
} from "../services/nativeWorkerService";

interface NativeWorkerDeviceSnapshot {
  source?: string;
  video?: unknown[];
  audio?: unknown[];
  diagnostics?: {
    workerDeviceMode?: string;
  };
}

export function NativeWorkerPanel() {
  const [probe, setProbe] = useState<NativeWorkerDeviceProbe | null>(null);
  const [session, setSession] = useState<NativeWorkerSessionSnapshot | null>(null);
  const [videoPayloadConsume, setVideoPayloadConsume] = useState<NativeWorkerPayloadConsumeResult | null>(null);
  const [audioPayloadConsume, setAudioPayloadConsume] = useState<NativeWorkerPayloadConsumeResult | null>(null);
  const [isProbing, setIsProbing] = useState(false);
  const [isSessionBusy, setIsSessionBusy] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const devices = (probe?.devices ?? null) as NativeWorkerDeviceSnapshot | null;
  const videoCount = Array.isArray(devices?.video) ? devices.video.length : 0;
  const audioCount = Array.isArray(devices?.audio) ? devices.audio.length : 0;
  const source = devices?.source ?? probe?.status ?? "not-probed";
  const workerMode = devices?.diagnostics?.workerDeviceMode ?? probe?.readiness.status ?? "unknown";
  const sessionState = session?.captureSession?.state ?? session?.state ?? "idle";
  const isSessionRunning = sessionState === "running";
  const boundVideoChannels = session?.captureSession?.boundVideoChannels ?? 0;
  const boundAudioEndpoints = session?.captureSession?.boundAudioEndpoints ?? 0;
  const videoThreadCount = session?.captureSession?.continuousVideoThreadCount ?? 0;
  const framesProduced = session?.stats?.framesProduced ?? 0;
  const audioPackets = session?.stats?.audioPacketsProduced ?? 0;
  const audioPayloadCopyCount = session?.stats?.audioPayloadCopyCount ?? 0;
  const audioPayloadCopyErrorCount = session?.stats?.audioPayloadCopyErrorCount ?? 0;
  const audioPayloadQueueBytes = session?.stats?.audioPayloadQueueBytes ?? 0;
  const audioPayloadConsumeCount = session?.stats?.audioPayloadConsumeCount ?? 0;
  const audioPayloadConsumedBytes = session?.stats?.audioPayloadConsumedBytes ?? 0;
  const frameQueuePushCount = session?.stats?.videoFrameQueuePushCount ?? 0;
  const frameQueueDropCount = session?.stats?.videoFrameQueueDropCount ?? 0;
  const payloadCopyCount = session?.stats?.videoPayloadCopyCount ?? 0;
  const payloadCopyErrorCount = session?.stats?.videoPayloadCopyErrorCount ?? 0;
  const payloadQueueBytes = session?.stats?.videoPayloadQueueBytes ?? 0;
  const payloadConsumeCount = session?.stats?.videoPayloadConsumeCount ?? 0;
  const payloadConsumedBytes = session?.stats?.videoPayloadConsumedBytes ?? 0;
  const drainVideoChannelId = firstBoundVideoChannelId(session);

  async function runProbe() {
    setIsProbing(true);
    setProbeError(null);
    try {
      const nextProbe = await probeNativeWorkerDevices();
      setProbe(nextProbe);
      if (nextProbe.status === "error" || nextProbe.status === "unavailable") {
        setProbeError(nextProbe.message);
      }
    } catch (error) {
      setProbeError(errorMessage(error));
    } finally {
      setIsProbing(false);
    }
  }

  async function startSession() {
    setIsSessionBusy(true);
    setSessionError(null);
    setVideoPayloadConsume(null);
    setAudioPayloadConsume(null);
    try {
      setSession(
        await startNativeWorkerSession({
          channels: ["field-camera", "endoscope"],
          videoMediaTypeIndex: 0,
          audioIndex: 0,
          startVideoThread: true,
          startAudioThread: true,
          videoFrameQueueCapacity: 3,
          audioPayloadQueueCapacity: 50,
        }),
      );
    } catch (error) {
      setSessionError(errorMessage(error));
    } finally {
      setIsSessionBusy(false);
    }
  }

  async function refreshSession() {
    setIsSessionBusy(true);
    setSessionError(null);
    try {
      setSession(await getNativeWorkerSessionStatus());
    } catch (error) {
      setSessionError(errorMessage(error));
    } finally {
      setIsSessionBusy(false);
    }
  }

  async function stopSession() {
    setIsSessionBusy(true);
    setSessionError(null);
    try {
      setSession(await stopNativeWorkerSession());
      setVideoPayloadConsume(null);
      setAudioPayloadConsume(null);
    } catch (error) {
      setSessionError(errorMessage(error));
    } finally {
      setIsSessionBusy(false);
    }
  }

  async function drainVideoPayloadQueue() {
    setIsSessionBusy(true);
    setSessionError(null);
    try {
      setVideoPayloadConsume(
        await consumeNativeWorkerVideoPayloadQueue({
          ...(drainVideoChannelId ? { channelId: drainVideoChannelId } : {}),
          maxFrames: 2,
        }),
      );
      setSession(await getNativeWorkerSessionStatus());
    } catch (error) {
      setSessionError(errorMessage(error));
    } finally {
      setIsSessionBusy(false);
    }
  }

  async function drainAudioPayloadQueue() {
    setIsSessionBusy(true);
    setSessionError(null);
    try {
      setAudioPayloadConsume(await consumeNativeWorkerAudioPayloadQueue({ maxPackets: 5 }));
      setSession(await getNativeWorkerSessionStatus());
    } catch (error) {
      setSessionError(errorMessage(error));
    } finally {
      setIsSessionBusy(false);
    }
  }

  async function drainInteractionPayloadQueues() {
    setIsSessionBusy(true);
    setSessionError(null);
    try {
      setVideoPayloadConsume(
        await consumeNativeWorkerVideoPayloadQueue({
          ...(drainVideoChannelId ? { channelId: drainVideoChannelId } : {}),
          maxFrames: 1,
        }),
      );
      setAudioPayloadConsume(await consumeNativeWorkerAudioPayloadQueue({ maxPackets: 5 }));
      setSession(await getNativeWorkerSessionStatus());
    } catch (error) {
      setSessionError(errorMessage(error));
    } finally {
      setIsSessionBusy(false);
    }
  }

  return (
    <section className="hmi-panel native-worker-panel">
      <div className="hmi-section-heading">
        <div>
          <span>Native Worker</span>
          <h2>Device Probe</h2>
        </div>
        <strong>{workerMode}</strong>
      </div>

      <div className="native-worker-grid">
        <div className="recording-stat">
          <Cpu size={18} />
          <strong>{source}</strong>
          <span>{probe?.message ?? "No device probe has run"}</span>
        </div>
        <div className="recording-stat">
          <Video size={18} />
          <strong>{videoCount} video</strong>
          <span>Media Foundation enumeration</span>
        </div>
        <div className="recording-stat">
          <Mic size={18} />
          <strong>{audioCount} audio</strong>
          <span>WASAPI capture endpoints</span>
        </div>
        <div className="recording-stat">
          <Cpu size={18} />
          <strong>{sessionState}</strong>
          <span>{framesProduced} video samples / {audioPackets} audio packets</span>
        </div>
        <div className="recording-stat">
          <Mic size={18} />
          <strong>{audioPayloadCopyCount} audio copies</strong>
          <span>
            {formatBytes(audioPayloadQueueBytes)} native PCM
            {audioPayloadCopyErrorCount > 0 ? ` / ${audioPayloadCopyErrorCount} copy errors` : ""}
          </span>
        </div>
        <div className="recording-stat">
          <Activity size={18} />
          <strong>{boundVideoChannels} video / {boundAudioEndpoints} audio</strong>
          <span>{videoThreadCount} native video thread{videoThreadCount === 1 ? "" : "s"}</span>
        </div>
        <div className="recording-stat">
          <Cpu size={18} />
          <strong>{frameQueuePushCount} push / {frameQueueDropCount} drop</strong>
          <span>
            {formatBytes(payloadQueueBytes)} native payload / {payloadCopyCount} copies
            {payloadCopyErrorCount > 0 ? ` / ${payloadCopyErrorCount} copy errors` : ""}
          </span>
        </div>
        <div className="recording-stat">
          <Activity size={18} />
          <strong>{payloadConsumeCount} video consumed</strong>
          <span>
            {drainVideoChannelId ?? "no video channel"} / {formatBytes(payloadConsumedBytes)} drained / {formatDrainDetail(videoPayloadConsume, "video")}
          </span>
        </div>
        <div className="recording-stat">
          <Mic size={18} />
          <strong>{audioPayloadConsumeCount} audio consumed</strong>
          <span>
            {formatBytes(audioPayloadConsumedBytes)} PCM drained / {formatDrainDetail(audioPayloadConsume, "audio")}
          </span>
        </div>
      </div>

      {probeError ? <div className="native-worker-alert">{probeError}</div> : null}
      {sessionError ? <div className="native-worker-alert">{sessionError}</div> : null}

      <div className="hmi-action-row">
        <button className="hmi-button primary" disabled={isProbing} onClick={runProbe} type="button">
          <RefreshCw size={15} />
          {isProbing ? "Probing" : "Probe devices"}
        </button>
        <button className="hmi-button" disabled={isSessionBusy || isSessionRunning} onClick={startSession} type="button">
          Start session
        </button>
        <button className="hmi-button" disabled={isSessionBusy} onClick={refreshSession} type="button">
          Status
        </button>
        <button className="hmi-button" disabled={isSessionBusy || !isSessionRunning} onClick={drainVideoPayloadQueue} type="button">
          Drain video
        </button>
        <button className="hmi-button" disabled={isSessionBusy || !isSessionRunning} onClick={drainAudioPayloadQueue} type="button">
          Drain audio
        </button>
        <button className="hmi-button" disabled={isSessionBusy || !isSessionRunning} onClick={drainInteractionPayloadQueues} type="button">
          <Activity size={15} />
          Drain AV
        </button>
        <button className="hmi-button danger" disabled={isSessionBusy || !isSessionRunning} onClick={stopSession} type="button">
          Stop
        </button>
      </div>
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDrainDetail(result: NativeWorkerPayloadConsumeResult | null, kind: "video" | "audio"): string {
  if (!result) return "not-drained";
  const pieces = [result.status ?? "unknown"];
  if (result.channelId) {
    pieces.push(result.channelId);
  }
  const latestSequence = result.latestSequence;
  if (typeof latestSequence === "number" && Number.isInteger(latestSequence)) {
    pieces.push(`seq ${latestSequence}`);
  }
  const remainingDepth = result.remainingDepth;
  if (typeof remainingDepth === "number" && Number.isFinite(remainingDepth)) {
    pieces.push(`depth ${remainingDepth}`);
  }
  const count = kind === "video" ? result.consumedFrames : result.consumedPackets;
  if (typeof count === "number" && Number.isFinite(count)) {
    pieces.push(`${count} ${kind === "video" ? "frames" : "packets"}`);
  }
  return pieces.join(" / ");
}

function firstBoundVideoChannelId(session: NativeWorkerSessionSnapshot | null): string | undefined {
  const channels = Array.isArray(session?.channels) ? session.channels : [];
  for (const channel of channels) {
    if (!isRecord(channel)) continue;
    if (channel.source !== "windows-native") continue;
    if (typeof channel.channelId === "string" && channel.channelId.trim()) {
      return channel.channelId;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
