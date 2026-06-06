import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(rootDir, "native-worker/Cargo.toml");

const channels = (process.env.SMARTST_NATIVE_SESSION_CHANNELS || "field-camera")
  .split(",")
  .map((channel) => channel.trim())
  .filter(Boolean);
const videoMediaTypeIndex = readIntegerEnv("SMARTST_NATIVE_VIDEO_MEDIA_TYPE_INDEX", 0);
const videoFrameQueueCapacity = readIntegerEnv("SMARTST_NATIVE_AV_SOAK_VIDEO_QUEUE_CAPACITY", 5);
const audioIndex = readIntegerEnv("SMARTST_NATIVE_AUDIO_INDEX", 0);
const audioPayloadQueueCapacity = readIntegerEnv("SMARTST_NATIVE_AV_SOAK_AUDIO_QUEUE_CAPACITY", 100);
const durationMs = readIntegerEnv("SMARTST_NATIVE_AV_SOAK_DURATION_MS", 5000);
const sampleIntervalMs = readIntegerEnv("SMARTST_NATIVE_AV_SOAK_SAMPLE_INTERVAL_MS", 500);
const drainIntervalMs = readIntegerEnv("SMARTST_NATIVE_AV_SOAK_DRAIN_INTERVAL_MS", 500);
const maxVideoFrames = readIntegerEnv("SMARTST_NATIVE_AV_SOAK_MAX_VIDEO_FRAMES", 2);
const maxAudioPackets = readIntegerEnv("SMARTST_NATIVE_AV_SOAK_MAX_AUDIO_PACKETS", 50);
const outputPath = resolve(
  rootDir,
  process.env.SMARTST_NATIVE_AV_SOAK_OUTPUT || "native-worker/.tmp/av-soak-smoke.json",
);

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
  const error = new Error(`native worker exited before AV soak completed. exit=${exitCode}. stderr=${stderr}`);
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
    videoMediaTypeIndex,
    videoFrameQueueCapacity,
    audioIndex,
    audioPayloadQueueCapacity,
    startVideoThread: true,
    startAudioThread: true,
  });

  const startedAt = Date.now();
  let nextDrainAt = startedAt + drainIntervalMs;
  const samples = [];
  const drainEvents = [];

  while (Date.now() - startedAt < durationMs) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, sampleIntervalMs));
    const now = Date.now();
    const elapsedMs = now - startedAt;
    samples.push(toSoakSample(elapsedMs, await request("status")));

    if (now >= nextDrainAt) {
      const video = await request("consumeVideoPayloadQueue", { maxFrames: maxVideoFrames });
      const audio = await request("consumeAudioPayloadQueue", { maxPackets: maxAudioPackets });
      drainEvents.push({
        elapsedMs,
        video: toVideoDrainEvent(video),
        audio: toAudioDrainEvent(audio),
      });
      nextDrainAt = now + drainIntervalMs;
    }
  }

  const finalStatus = await request("status");
  const stopped = await request("stop");
  assert(stopped.captureSession?.state === "idle", "worker stops after AV soak");

  const summary = summarizeSoak({
    started,
    finalStatus,
    stopped,
    samples,
    drainEvents,
    durationMs,
    sampleIntervalMs,
    drainIntervalMs,
    videoFrameQueueCapacity,
    audioPayloadQueueCapacity,
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  completed = true;
  console.log(JSON.stringify(summary, null, 2));
  await request("shutdown");
} finally {
  child.stdin.end();
  child.kill();
}

function toSoakSample(elapsedMs, snapshot) {
  const videoThreads = getVideoThreads(snapshot.stats);
  const videoThread = videoThreads[0] ?? null;
  const audioThread = snapshot.stats?.audioCaptureThread ?? null;
  return {
    elapsedMs,
    videoThreadCount: videoThreads.length,
    video: videoThread
      ? {
          channelId: videoThread.channelId,
          sampleCount: videoThread.sampleCount ?? 0,
          copyCount: videoThread.frameQueue?.payloadQueue?.copyCount ?? 0,
          copyErrorCount: videoThread.frameQueue?.payloadQueue?.copyErrorCount ?? 0,
          dropCount: videoThread.frameQueue?.dropCount ?? 0,
          queueDepth: videoThread.frameQueue?.payloadQueue?.depth ?? 0,
          queueBytes: videoThread.frameQueue?.payloadQueue?.bytes ?? 0,
          consumeCount: videoThread.frameQueue?.payloadQueue?.consumeCount ?? 0,
          consumerStatus: videoThread.frameQueue?.consumerStatus ?? "unknown",
        }
      : null,
    audio: audioThread
      ? {
          packetCount: audioThread.packetCount ?? 0,
          copyCount: audioThread.payloadQueue?.copyCount ?? 0,
          copyErrorCount: audioThread.payloadQueue?.copyErrorCount ?? 0,
          dropCount: audioThread.payloadQueue?.dropCount ?? 0,
          queueDepth: audioThread.payloadQueue?.depth ?? 0,
          queueBytes: audioThread.payloadQueue?.bytes ?? 0,
          consumeCount: audioThread.payloadQueue?.consumeCount ?? 0,
          consumerStatus: audioThread.payloadQueue?.consumerStatus ?? "unknown",
          levelStatus: audioThread.audioLevel?.status ?? "unknown",
          rms: numberOrNull(audioThread.audioLevel?.rms),
          peak: numberOrNull(audioThread.audioLevel?.peak),
        }
      : null,
  };
}

function toVideoDrainEvent(drained) {
  return {
    status: drained.status,
    channelId: drained.channelId,
    consumedFrames: drained.consumedFrames ?? 0,
    consumedBytes: drained.consumedBytes ?? 0,
    latestSequence: drained.latestSequence ?? null,
    remainingDepth: drained.remainingDepth ?? null,
    exportedOverJson: drained.exportedOverJson,
  };
}

function toAudioDrainEvent(drained) {
  return {
    status: drained.status,
    consumedPackets: drained.consumedPackets ?? 0,
    consumedBytes: drained.consumedBytes ?? 0,
    latestSequence: drained.latestSequence ?? null,
    remainingDepth: drained.remainingDepth ?? null,
    payloadTransport: drained.payloadTransport,
    exportedOverJson: drained.exportedOverJson,
  };
}

function summarizeSoak(profile) {
  const boundVideoChannels = profile.started.captureSession?.boundVideoChannels ?? 0;
  const boundAudioEndpoints = profile.started.captureSession?.boundAudioEndpoints ?? 0;
  if (boundVideoChannels === 0 || boundAudioEndpoints === 0) {
    return {
      schemaVersion: "smartst.native-av-soak.v0.1",
      status: "skipped",
      reason: "missing-bound-media-endpoint",
      mode: profile.started.captureSession?.mode,
      boundVideoChannels,
      boundAudioEndpoints,
      outputPath,
      stoppedState: profile.stopped.captureSession?.state,
    };
  }

  const videoSamples = profile.samples.map((sample) => sample.video).filter(Boolean);
  const audioSamples = profile.samples.map((sample) => sample.audio).filter(Boolean);
  const videoDrainEvents = profile.drainEvents.map((event) => event.video);
  const audioDrainEvents = profile.drainEvents.map((event) => event.audio);

  assert(profile.samples.length >= 3, "AV soak collects at least 3 status samples");
  assert(profile.drainEvents.length >= 3, "AV soak performs at least 3 drain cycles");

  return {
    schemaVersion: "smartst.native-av-soak.v0.1",
    status: "passed",
    mode: profile.started.captureSession?.mode,
    durationMs: profile.durationMs,
    sampleIntervalMs: profile.sampleIntervalMs,
    drainIntervalMs: profile.drainIntervalMs,
    sampleCount: profile.samples.length,
    drainEventCount: profile.drainEvents.length,
    boundVideoChannels,
    boundAudioEndpoints,
    video: summarizeVideoSoak(videoSamples, videoDrainEvents, profile.videoFrameQueueCapacity),
    audio: summarizeAudioSoak(audioSamples, audioDrainEvents, profile.audioPayloadQueueCapacity),
    outputPath,
    stoppedState: profile.stopped.captureSession?.state,
  };
}

function summarizeVideoSoak(samples, drainEvents, capacity) {
  assert(samples.length > 0, "AV soak has video samples");
  assert(drainEvents.some((event) => event.consumedFrames > 0), "AV soak consumes video frames");
  assert(drainEvents.every((event) => event.exportedOverJson === false), "AV soak does not export video payload over JSON");
  const first = samples[0];
  const last = samples[samples.length - 1];
  const maxDepth = max(samples.map((sample) => sample.queueDepth));
  assert(maxDepth <= capacity, `video queue depth ${maxDepth} exceeds capacity ${capacity}`);
  assert(last.copyCount > first.copyCount, "AV soak video copy count increases");
  assert(last.copyErrorCount === 0, "AV soak video payload copy errors stay at 0");
  const consumedEvents = drainEvents.filter((event) => event.consumedFrames > 0);
  return {
    channelId: last.channelId,
    samplesProduced: last.sampleCount - first.sampleCount,
    copyDelta: last.copyCount - first.copyCount,
    consumedFrames: sum(consumedEvents.map((event) => event.consumedFrames)),
    consumedBytes: sum(consumedEvents.map((event) => event.consumedBytes)),
    consumedEventCount: consumedEvents.length,
    maxDepth,
    maxBytes: max(samples.map((sample) => sample.queueBytes)),
    dropCountEnd: last.dropCount,
    consumeCountEnd: last.consumeCount,
    consumerStatus: last.consumerStatus,
    exportedOverJson: false,
  };
}

function summarizeAudioSoak(samples, drainEvents, capacity) {
  assert(samples.length > 0, "AV soak has audio samples");
  assert(drainEvents.some((event) => event.consumedPackets > 0), "AV soak consumes audio packets");
  assert(drainEvents.every((event) => event.exportedOverJson === false), "AV soak does not export audio payload over JSON");
  assert(drainEvents.every((event) => event.payloadTransport === "native-only"), "AV soak audio stays native-only");
  const first = samples[0];
  const last = samples[samples.length - 1];
  const maxDepth = max(samples.map((sample) => sample.queueDepth));
  assert(maxDepth <= capacity, `audio queue depth ${maxDepth} exceeds capacity ${capacity}`);
  assert(last.copyCount > first.copyCount, "AV soak audio copy count increases");
  assert(last.copyErrorCount === 0, "AV soak audio payload copy errors stay at 0");
  const consumedEvents = drainEvents.filter((event) => event.consumedPackets > 0);
  return {
    packetsProduced: last.packetCount - first.packetCount,
    copyDelta: last.copyCount - first.copyCount,
    consumedPackets: sum(consumedEvents.map((event) => event.consumedPackets)),
    consumedBytes: sum(consumedEvents.map((event) => event.consumedBytes)),
    consumedEventCount: consumedEvents.length,
    maxDepth,
    maxBytes: max(samples.map((sample) => sample.queueBytes)),
    dropCountEnd: last.dropCount,
    consumeCountEnd: last.consumeCount,
    consumerStatus: last.consumerStatus,
    levelStatus: last.levelStatus,
    rms: last.rms,
    peak: last.peak,
    exportedOverJson: false,
  };
}

function getVideoThreads(stats) {
  if (Array.isArray(stats?.videoCaptureThreads)) return stats.videoCaptureThreads;
  if (stats?.videoCaptureThread) return [stats.videoCaptureThread];
  return [];
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

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function max(values) {
  return values.reduce((largest, value) => Math.max(largest, value), 0);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
