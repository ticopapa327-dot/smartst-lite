import { Cpu, Mic, RefreshCw, Video } from "lucide-react";
import { useState } from "react";
import {
  probeNativeWorkerDevices,
  type NativeWorkerDeviceProbe,
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
  const [isProbing, setIsProbing] = useState(false);

  const devices = (probe?.devices ?? null) as NativeWorkerDeviceSnapshot | null;
  const videoCount = Array.isArray(devices?.video) ? devices.video.length : 0;
  const audioCount = Array.isArray(devices?.audio) ? devices.audio.length : 0;
  const source = devices?.source ?? probe?.status ?? "not-probed";
  const workerMode = devices?.diagnostics?.workerDeviceMode ?? probe?.readiness.status ?? "unknown";

  async function runProbe() {
    setIsProbing(true);
    try {
      setProbe(await probeNativeWorkerDevices());
    } finally {
      setIsProbing(false);
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
      </div>

      <div className="hmi-action-row">
        <button className="hmi-button primary" disabled={isProbing} onClick={runProbe} type="button">
          <RefreshCw size={15} />
          {isProbing ? "Probing" : "Probe devices"}
        </button>
      </div>
    </section>
  );
}
