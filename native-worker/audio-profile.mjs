import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(rootDir, "native-worker/Cargo.toml");

const channels = (process.env.SMARTST_NATIVE_SESSION_CHANNELS || "field-camera")
  .split(",")
  .map((channel) => channel.trim())
  .filter(Boolean);
const audioIndex = readIntegerEnv("SMARTST_NATIVE_AUDIO_INDEX", 0);
const durationMs = readIntegerEnv("SMARTST_NATIVE_AUDIO_PROFILE_DURATION_MS", 2000);
const sampleIntervalMs = readIntegerEnv("SMARTST_NATIVE_AUDIO_PROFILE_SAMPLE_INTERVAL_MS", 500);
const audioPayloadQueueCapacity = readIntegerEnv("SMARTST_NATIVE_AUDIO_PAYLOAD_QUEUE_CAPACITY", 50);
const label = process.env.SMARTST_NATIVE_AUDIO_PROFILE_LABEL || "default";
const outputPath = process.env.SMARTST_NATIVE_AUDIO_PROFILE_OUTPUT || "";

const child = spawn("cargo", ["run", "--quiet", "--manifest-path", manifestPath], {
  cwd: rootDir,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

const pending = new Map();
let stdoutBuffer = "";
let stderr = "";
let completed = false;
let resolveReady;
let rejectReady;
const ready = new Promise((resolvePromise, rejectPromise) => {
  resolveReady = resolvePromise;
  rejectReady = rejectPromise;
});

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  let newlineIndex = stdoutBuffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = stdoutBuffer.slice(0, newlineIndex);
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    handleLine(line);
    newlineIndex = stdoutBuffer.indexOf("\n");
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

child.on("close", (exitCode) => {
  if (completed) return;
  const error = new Error(`native worker exited before audio profile completed. exit=${exitCode}. stderr=${stderr}`);
  rejectReady(error);
  for (const handler of pending.values()) {
    handler.reject(error);
  }
  pending.clear();
});

try {
  const readyTimeout = setTimeout(() => {
    rejectReady(new Error(`worker ready timed out. stderr=${stderr}`));
  }, 30000);
  await ready;
  clearTimeout(readyTimeout);

  const started = await request("start", {
    channels,
    audioIndex,
    audioPayloadQueueCapacity,
    startVideoThread: false,
    startAudioThread: true,
  });

  const samples = [];
  const startedAt = Date.now();
  while (Date.now() - startedAt < durationMs) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, sampleIntervalMs));
    const status = await request("status");
    const audioThread = status.stats?.audioCaptureThread;
    if (audioThread) {
      samples.push(toAudioProfileSample(audioThread));
    }
  }

  const stopped = await request("stop");
  assert(stopped.captureSession?.state === "idle", "worker stops after audio profile");

  const summary = summarizeAudioProfile({
    label,
    mode: started.captureSession?.mode,
    boundAudioEndpoints: started.captureSession?.boundAudioEndpoints ?? 0,
    durationMs,
    sampleIntervalMs,
    samples,
    stoppedState: stopped.captureSession?.state,
  });

  if (outputPath) {
    const resolvedOutputPath = isAbsolute(outputPath) ? outputPath : resolve(rootDir, outputPath);
    await writeFile(resolvedOutputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(summary, null, 2));
  completed = true;
  await request("shutdown");
} finally {
  child.stdin.end();
  child.kill();
}

function toAudioProfileSample(audioThread) {
  return {
    elapsedMs: audioThread.elapsedMs ?? 0,
    state: audioThread.state ?? "unknown",
    packetCount: audioThread.packetCount ?? 0,
    capturedFrames: audioThread.capturedFrames ?? 0,
    capturedBytes: audioThread.capturedBytes ?? 0,
    silentPackets: audioThread.silentPackets ?? 0,
    discontinuityPackets: audioThread.discontinuityPackets ?? 0,
    timestampErrorPackets: audioThread.timestampErrorPackets ?? 0,
    levelStatus: audioThread.audioLevel?.status ?? "unknown",
    levelFormat: audioThread.audioLevel?.format ?? "unknown",
    rms: numberOrNull(audioThread.audioLevel?.rms),
    peak: numberOrNull(audioThread.audioLevel?.peak),
    lastPacketRms: numberOrNull(audioThread.audioLevel?.lastPacketRms),
    lastPacketPeak: numberOrNull(audioThread.audioLevel?.lastPacketPeak),
    lastPacketFrames: audioThread.audioLevel?.lastPacketFrames ?? null,
    payloadQueueDepth: audioThread.payloadQueue?.depth ?? 0,
    payloadQueueBytes: audioThread.payloadQueue?.bytes ?? 0,
    payloadCopyCount: audioThread.payloadQueue?.copyCount ?? 0,
    payloadCopyErrorCount: audioThread.payloadQueue?.copyErrorCount ?? 0,
    payloadDropCount: audioThread.payloadQueue?.dropCount ?? 0,
  };
}

function summarizeAudioProfile(profile) {
  if (profile.boundAudioEndpoints <= 0) {
    return {
      status: "skipped",
      reason: "no-bound-audio-endpoint",
      ...profile,
      samples: [],
    };
  }
  assert(profile.samples.length > 0, "audio profile collects at least one sample");
  const first = profile.samples[0];
  const last = profile.samples[profile.samples.length - 1];
  assert(last.packetCount > first.packetCount, "audio packet count increases during profile");

  const measuredSamples = profile.samples.filter((sample) => sample.levelStatus === "measured");
  const rmsValues = measuredSamples.map((sample) => sample.rms).filter((value) => value !== null);
  const peakValues = measuredSamples.map((sample) => sample.peak).filter((value) => value !== null);
  const packetDelta = last.packetCount - first.packetCount;
  const payloadCopyDelta = last.payloadCopyCount - first.payloadCopyCount;

  return {
    status: "passed",
    label: profile.label,
    mode: profile.mode,
    boundAudioEndpoints: profile.boundAudioEndpoints,
    durationMs: profile.durationMs,
    sampleIntervalMs: profile.sampleIntervalMs,
    sampleCount: profile.samples.length,
    packetCountStart: first.packetCount,
    packetCountEnd: last.packetCount,
    packetsProduced: packetDelta,
    capturedFramesEnd: last.capturedFrames,
    capturedBytesEnd: last.capturedBytes,
    silentPacketsEnd: last.silentPackets,
    discontinuityPacketsEnd: last.discontinuityPackets,
    timestampErrorPacketsEnd: last.timestampErrorPackets,
    audioLevelStatus: last.levelStatus,
    audioLevelFormat: last.levelFormat,
    rms: summarizeValues(rmsValues),
    peak: summarizeValues(peakValues),
    payloadCopyCountEnd: last.payloadCopyCount,
    payloadCopyDelta,
    payloadQueueBytesEnd: last.payloadQueueBytes,
    payloadCopyErrorCountEnd: last.payloadCopyErrorCount,
    payloadDropCountEnd: last.payloadDropCount,
    stoppedState: profile.stoppedState,
    samples: profile.samples,
  };
}

function summarizeValues(values) {
  if (values.length === 0) {
    return { count: 0, min: null, average: null, max: null };
  }
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    count: values.length,
    min: Math.min(...values),
    average: sum / values.length,
    max: Math.max(...values),
  };
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function request(method, params, timeoutMs = 30000) {
  const id = `${method}-${Date.now()}-${Math.random()}`;
  const result = new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      rejectPromise(new Error(`${method} timed out. stderr=${stderr}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolvePromise(value);
      },
      reject: (error) => {
        clearTimeout(timeout);
        rejectPromise(error);
      },
    });
  });

  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  return result;
}

function handleLine(line) {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.type === "event" && message.event?.category === "worker" && message.event?.name === "ready") {
    resolveReady();
    return;
  }
  if (message.type === "response") {
    const handler = pending.get(message.id);
    if (!handler) return;
    pending.delete(message.id);
    if (message.ok) {
      handler.resolve(message.result);
      return;
    }
    handler.reject(new Error(message.error?.message || "native worker response failed"));
  }
}

function readIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
