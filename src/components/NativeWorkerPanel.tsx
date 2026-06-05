import { Activity, Cpu, Mic, RefreshCw, Video } from "lucide-react";
import { useState } from "react";
import {
  getNativeWorkerSessionStatus,
  probeNativeWorkerDevices,
  startNativeWorkerSession,
  stopNativeWorkerSession,
  type NativeWorkerDeviceProbe,
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
  const frameQueuePushCount = session?.stats?.videoFrameQueuePushCount ?? 0;
  const frameQueueDropCount = session?.stats?.videoFrameQueueDropCount ?? 0;
  const realMediaSession = session?.stats?.realMediaSession === true;

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
    try {
      setSession(
        await startNativeWorkerSession({
          channels: ["field-camera", "endoscope"],
          videoMediaTypeIndex: 0,
          audioIndex: 0,
          startVideoThread: true,
          startAudioThread: true,
          videoFrameQueueCapacity: 3,
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
          <Activity size={18} />
          <strong>{boundVideoChannels} video / {boundAudioEndpoints} audio</strong>
          <span>{videoThreadCount} native video thread{videoThreadCount === 1 ? "" : "s"}</span>
        </div>
        <div className="recording-stat">
          <Cpu size={18} />
          <strong>{frameQueuePushCount} push / {frameQueueDropCount} drop</strong>
          <span>{realMediaSession ? "real media session" : "media session idle"}</span>
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
