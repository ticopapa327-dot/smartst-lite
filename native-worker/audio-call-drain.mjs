import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(rootDir, "native-worker/Cargo.toml");

const channels = (process.env.SMARTST_NATIVE_SESSION_CHANNELS || "field-camera")
  .split(",")
  .map((channel) => channel.trim())
  .filter(Boolean);
const audioIndex = readIntegerEnv("SMARTST_NATIVE_AUDIO_INDEX", 0);
const audioPayloadQueueCapacity = readIntegerEnv("SMARTST_NATIVE_AUDIO_PAYLOAD_QUEUE_CAPACITY", 50);
const durationMs = readIntegerEnv("SMARTST_NATIVE_AUDIO_CALL_DRAIN_DURATION_MS", 2000);
const intervalMs = readIntegerEnv("SMARTST_NATIVE_AUDIO_CALL_DRAIN_INTERVAL_MS", 250);
const maxPackets = readIntegerEnv("SMARTST_NATIVE_AUDIO_CALL_DRAIN_MAX_PACKETS", 5);

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
  const error = new Error(`native worker exited before audio call drain completed. exit=${exitCode}. stderr=${stderr}`);
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

  const startedAt = Date.now();
  const drainEvents = [];
  while (Date.now() - startedAt < durationMs) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
    const elapsedMs = Date.now() - startedAt;
    const drained = await request("consumeAudioPayloadQueue", { maxPackets });
    drainEvents.push({
      elapsedMs,
      status: drained.status,
      consumedPackets: drained.consumedPackets ?? 0,
      consumedBytes: drained.consumedBytes ?? 0,
      latestSequence: drained.latestSequence ?? null,
      remainingDepth: drained.remainingDepth ?? null,
      remainingBytes: drained.remainingBytes ?? null,
      consumer: drained.consumer ?? null,
      payloadTransport: drained.payloadTransport,
      exportedOverJson: drained.exportedOverJson,
    });
  }

  const status = await request("status");
  const stopped = await request("stop");
  assert(stopped.captureSession?.state === "idle", "worker stops after audio call drain");
  const summary = summarize({
    started,
    status,
    stopped,
    durationMs,
    intervalMs,
    maxPackets,
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
  const boundAudioEndpoints = profile.started.captureSession?.boundAudioEndpoints ?? 0;
  if (boundAudioEndpoints === 0) {
    return {
      status: "skipped",
      reason: "no-bound-audio-endpoint",
      mode: profile.started.captureSession?.mode,
      boundAudioEndpoints,
      stoppedState: profile.stopped.captureSession?.state,
    };
  }

  const consumedEvents = profile.drainEvents.filter((event) => event.consumedPackets > 0);
  assert(consumedEvents.length >= 3, "audio call drain consumes at least 3 PCM packet batches");
  assert(consumedEvents.every((event) => event.exportedOverJson === false), "audio call drain never exports PCM payload over JSON");
  assert(consumedEvents.every((event) => event.payloadTransport === "native-only"), "audio call drain stays native-only");
  assert(consumedEvents.every((event) => event.consumedBytes > 0), "audio call drain reports consumed bytes");
  const sequences = consumedEvents
    .map((event) => event.latestSequence)
    .filter((sequence) => Number.isInteger(sequence));
  assert(sequences.length >= 3, "audio call drain receives sequence metadata");
  for (let index = 1; index < sequences.length; index += 1) {
    assert(sequences[index] > sequences[index - 1], "audio call drain sequence metadata is increasing");
  }
  const audioThread = profile.status.stats?.audioCaptureThread;
  assert(audioThread?.payloadQueue?.consumerStatus === "manual-drain", "audio call drain consumer status is visible");

  return {
    status: "passed",
    mode: profile.started.captureSession?.mode,
    durationMs: profile.durationMs,
    intervalMs: profile.intervalMs,
    maxPackets: profile.maxPackets,
    boundAudioEndpoints,
    eventCount: profile.drainEvents.length,
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

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
