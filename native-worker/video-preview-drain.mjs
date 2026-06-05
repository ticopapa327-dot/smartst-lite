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
const videoFrameQueueCapacity = readIntegerEnv("SMARTST_NATIVE_VIDEO_FRAME_QUEUE_CAPACITY", 3);
const durationMs = readIntegerEnv("SMARTST_NATIVE_PREVIEW_DRAIN_DURATION_MS", 2000);
const intervalMs = readIntegerEnv("SMARTST_NATIVE_PREVIEW_DRAIN_INTERVAL_MS", 250);
const maxFrames = readIntegerEnv("SMARTST_NATIVE_PREVIEW_DRAIN_MAX_FRAMES", 1);

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
  const error = new Error(`native worker exited before video preview drain completed. exit=${exitCode}. stderr=${stderr}`);
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
    startVideoThread: true,
    startAudioThread: false,
  });

  const startedAt = Date.now();
  const drainEvents = [];
  while (Date.now() - startedAt < durationMs) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
    const elapsedMs = Date.now() - startedAt;
    const drained = await request("consumeVideoPayloadQueue", { maxFrames });
    drainEvents.push({
      elapsedMs,
      status: drained.status,
      channelId: drained.channelId,
      consumedFrames: drained.consumedFrames ?? 0,
      consumedBytes: drained.consumedBytes ?? 0,
      latestSequence: drained.latestSequence ?? null,
      remainingDepth: drained.remainingDepth ?? null,
      remainingBytes: drained.remainingBytes ?? null,
      consumer: drained.consumer ?? null,
      exportedOverJson: drained.exportedOverJson,
    });
  }

  const status = await request("status");
  const stopped = await request("stop");
  assert(stopped.captureSession?.state === "idle", "worker stops after video preview drain");
  const summary = summarize({
    started,
    status,
    stopped,
    durationMs,
    intervalMs,
    maxFrames,
    drainEvents,
  });
  completed = true;
  console.log(JSON.stringify(summary, null, 2));
  await request("shutdown");
} finally {
  child.stdin.end();
  child.kill();
}

function summarize(profile) {
  const boundVideoChannels = profile.started.captureSession?.boundVideoChannels ?? 0;
  if (boundVideoChannels === 0) {
    return {
      status: "skipped",
      reason: "no-bound-video-channel",
      mode: profile.started.captureSession?.mode,
      boundVideoChannels,
      stoppedState: profile.stopped.captureSession?.state,
    };
  }

  const consumedEvents = profile.drainEvents.filter((event) => event.consumedFrames > 0);
  assert(consumedEvents.length >= 3, "preview drain consumes at least 3 video frames");
  assert(consumedEvents.every((event) => event.exportedOverJson === false), "preview drain never exports frame payload over JSON");
  assert(consumedEvents.every((event) => event.consumedBytes > 0), "preview drain reports consumed bytes");
  const sequences = consumedEvents
    .map((event) => event.latestSequence)
    .filter((sequence) => Number.isInteger(sequence));
  assert(sequences.length >= 3, "preview drain receives sequence metadata");
  for (let index = 1; index < sequences.length; index += 1) {
    assert(sequences[index] > sequences[index - 1], "preview drain sequence metadata is increasing");
  }
  const firstThread = getVideoThreads(profile.status.stats)[0];
  assert(firstThread?.frameQueue?.consumerStatus === "manual-drain", "preview drain consumer status is visible");

  return {
    status: "passed",
    mode: profile.started.captureSession?.mode,
    durationMs: profile.durationMs,
    intervalMs: profile.intervalMs,
    maxFrames: profile.maxFrames,
    boundVideoChannels,
    eventCount: profile.drainEvents.length,
    consumedEventCount: consumedEvents.length,
    totalConsumedFrames: sum(consumedEvents.map((event) => event.consumedFrames)),
    totalConsumedBytes: sum(consumedEvents.map((event) => event.consumedBytes)),
    firstSequence: sequences[0],
    lastSequence: sequences[sequences.length - 1],
    finalConsumerStatus: firstThread.frameQueue.consumerStatus,
    finalQueueDepth: firstThread.frameQueue.payloadQueue.depth,
    exportedOverJson: false,
    stoppedState: profile.stopped.captureSession?.state,
  };
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

function getVideoThreads(stats) {
  if (Array.isArray(stats?.videoCaptureThreads)) return stats.videoCaptureThreads;
  if (stats?.videoCaptureThread) return [stats.videoCaptureThread];
  return [];
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

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
