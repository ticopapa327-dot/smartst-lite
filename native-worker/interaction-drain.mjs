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
const audioIndex = readIntegerEnv("SMARTST_NATIVE_AUDIO_INDEX", 0);
const audioPayloadQueueCapacity = readIntegerEnv("SMARTST_NATIVE_AUDIO_PAYLOAD_QUEUE_CAPACITY", 50);
const durationMs = readIntegerEnv("SMARTST_NATIVE_INTERACTION_DRAIN_DURATION_MS", 2000);
const intervalMs = readIntegerEnv("SMARTST_NATIVE_INTERACTION_DRAIN_INTERVAL_MS", 250);
const maxVideoFrames = readIntegerEnv("SMARTST_NATIVE_INTERACTION_DRAIN_MAX_VIDEO_FRAMES", 1);
const maxAudioPackets = readIntegerEnv("SMARTST_NATIVE_INTERACTION_DRAIN_MAX_AUDIO_PACKETS", 5);

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
  const error = new Error(`native worker exited before interaction drain completed. exit=${exitCode}. stderr=${stderr}`);
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
  const videoDrainEvents = [];
  const audioDrainEvents = [];
  while (Date.now() - startedAt < durationMs) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
    const elapsedMs = Date.now() - startedAt;
    const drainedVideo = await request("consumeVideoPayloadQueue", { maxFrames: maxVideoFrames });
    videoDrainEvents.push(toVideoDrainEvent(elapsedMs, drainedVideo));
    const drainedAudio = await request("consumeAudioPayloadQueue", { maxPackets: maxAudioPackets });
    audioDrainEvents.push(toAudioDrainEvent(elapsedMs, drainedAudio));
  }

  const status = await request("status");
  const stopped = await request("stop");
  assert(stopped.captureSession?.state === "idle", "worker stops after interaction drain");
  const summary = summarize({
    started,
    status,
    stopped,
    durationMs,
    intervalMs,
    maxVideoFrames,
    maxAudioPackets,
    videoDrainEvents,
    audioDrainEvents,
  });
  completed = true;
  console.log(JSON.stringify(summary, null, 2));
  await request("shutdown");
} finally {
  child.stdin.end();
  child.kill();
}

function toVideoDrainEvent(elapsedMs, drained) {
  return {
    elapsedMs,
    status: drained.status,
    channelId: drained.channelId,
    consumedFrames: drained.consumedFrames ?? 0,
    consumedBytes: drained.consumedBytes ?? 0,
    latestSequence: drained.latestSequence ?? null,
    remainingDepth: drained.remainingDepth ?? null,
    exportedOverJson: drained.exportedOverJson,
  };
}

function toAudioDrainEvent(elapsedMs, drained) {
  return {
    elapsedMs,
    status: drained.status,
    consumedPackets: drained.consumedPackets ?? 0,
    consumedBytes: drained.consumedBytes ?? 0,
    latestSequence: drained.latestSequence ?? null,
    remainingDepth: drained.remainingDepth ?? null,
    payloadTransport: drained.payloadTransport,
    exportedOverJson: drained.exportedOverJson,
  };
}

function summarize(profile) {
  const boundVideoChannels = profile.started.captureSession?.boundVideoChannels ?? 0;
  const boundAudioEndpoints = profile.started.captureSession?.boundAudioEndpoints ?? 0;
  if (boundVideoChannels === 0 || boundAudioEndpoints === 0) {
    return {
      status: "skipped",
      reason: "missing-bound-media-endpoint",
      mode: profile.started.captureSession?.mode,
      boundVideoChannels,
      boundAudioEndpoints,
      stoppedState: profile.stopped.captureSession?.state,
    };
  }

  const videoThreads = getVideoThreads(profile.status.stats);
  const firstVideoThread = videoThreads[0];
  const audioThread = profile.status.stats?.audioCaptureThread;
  const video = summarizeVideoDrain(profile.videoDrainEvents, firstVideoThread);
  const audio = summarizeAudioDrain(profile.audioDrainEvents, audioThread);

  return {
    status: "passed",
    mode: profile.started.captureSession?.mode,
    durationMs: profile.durationMs,
    intervalMs: profile.intervalMs,
    boundVideoChannels,
    boundAudioEndpoints,
    video,
    audio,
    stoppedState: profile.stopped.captureSession?.state,
  };
}

function summarizeVideoDrain(events, firstVideoThread) {
  const consumedEvents = events.filter((event) => event.consumedFrames > 0);
  assert(consumedEvents.length >= 3, "interaction drain consumes at least 3 video frames");
  assert(consumedEvents.every((event) => event.exportedOverJson === false), "interaction drain never exports video payload over JSON");
  assert(consumedEvents.every((event) => event.consumedBytes > 0), "interaction drain reports video consumed bytes");
  const sequences = increasingSequences(consumedEvents, "interaction video drain");
  assert(firstVideoThread?.frameQueue?.consumerStatus === "manual-drain", "interaction video consumer status is visible");
  return {
    maxFrames: max(consumedEvents.map((event) => event.consumedFrames)),
    eventCount: events.length,
    consumedEventCount: consumedEvents.length,
    totalConsumedFrames: sum(consumedEvents.map((event) => event.consumedFrames)),
    totalConsumedBytes: sum(consumedEvents.map((event) => event.consumedBytes)),
    firstSequence: sequences[0],
    lastSequence: sequences[sequences.length - 1],
    finalConsumerStatus: firstVideoThread.frameQueue.consumerStatus,
    finalQueueDepth: firstVideoThread.frameQueue.payloadQueue.depth,
    exportedOverJson: false,
  };
}

function summarizeAudioDrain(events, audioThread) {
  const consumedEvents = events.filter((event) => event.consumedPackets > 0);
  assert(consumedEvents.length >= 3, "interaction drain consumes at least 3 audio packet batches");
  assert(consumedEvents.every((event) => event.exportedOverJson === false), "interaction drain never exports audio payload over JSON");
  assert(consumedEvents.every((event) => event.payloadTransport === "native-only"), "interaction drain stays native-only for audio");
  assert(consumedEvents.every((event) => event.consumedBytes > 0), "interaction drain reports audio consumed bytes");
  const sequences = increasingSequences(consumedEvents, "interaction audio drain");
  assert(audioThread?.payloadQueue?.consumerStatus === "manual-drain", "interaction audio consumer status is visible");
  return {
    maxPackets: max(consumedEvents.map((event) => event.consumedPackets)),
    eventCount: events.length,
    consumedEventCount: consumedEvents.length,
    totalConsumedPackets: sum(consumedEvents.map((event) => event.consumedPackets)),
    totalConsumedBytes: sum(consumedEvents.map((event) => event.consumedBytes)),
    firstSequence: sequences[0],
    lastSequence: sequences[sequences.length - 1],
    finalConsumerStatus: audioThread.payloadQueue.consumerStatus,
    finalQueueDepth: audioThread.payloadQueue.depth,
    audioLevelStatus: audioThread.audioLevel?.status ?? "unknown",
    rms: numberOrNull(audioThread.audioLevel?.rms),
    peak: numberOrNull(audioThread.audioLevel?.peak),
    exportedOverJson: false,
  };
}

function increasingSequences(events, label) {
  const sequences = events
    .map((event) => event.latestSequence)
    .filter((sequence) => Number.isInteger(sequence));
  assert(sequences.length >= 3, `${label} receives sequence metadata`);
  for (let index = 1; index < sequences.length; index += 1) {
    assert(sequences[index] > sequences[index - 1], `${label} sequence metadata is increasing`);
  }
  return sequences;
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
