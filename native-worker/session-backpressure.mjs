import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(rootDir, "native-worker/Cargo.toml");

const channels = (process.env.UST_NATIVE_SESSION_CHANNELS || "field-camera,endoscope")
  .split(",")
  .map((channel) => channel.trim())
  .filter(Boolean);
const videoMediaTypeIndex = readIntegerEnv("UST_NATIVE_VIDEO_MEDIA_TYPE_INDEX", 0);
const videoThreadLimit = readIntegerEnv("UST_NATIVE_VIDEO_THREAD_LIMIT", undefined);
const videoFrameQueueCapacity = readIntegerEnv("UST_NATIVE_VIDEO_FRAME_QUEUE_CAPACITY", 3);
const audioIndex = readIntegerEnv("UST_NATIVE_AUDIO_INDEX", 0);
const audioPayloadQueueCapacity = readIntegerEnv("UST_NATIVE_AUDIO_PAYLOAD_QUEUE_CAPACITY", 50);
const durationMs = readIntegerEnv("UST_NATIVE_BACKPRESSURE_DURATION_MS", 3000);
const sampleIntervalMs = readIntegerEnv("UST_NATIVE_BACKPRESSURE_SAMPLE_INTERVAL_MS", 500);
const consumeVideoEveryMs = readIntegerEnv("UST_NATIVE_BACKPRESSURE_CONSUME_VIDEO_EVERY_MS", 0);
const consumeAudioEveryMs = readIntegerEnv("UST_NATIVE_BACKPRESSURE_CONSUME_AUDIO_EVERY_MS", 0);
const maxVideoFrames = readIntegerEnv("UST_NATIVE_VIDEO_PAYLOAD_CONSUME_MAX_FRAMES", 2);
const maxAudioPackets = readIntegerEnv("UST_NATIVE_AUDIO_PAYLOAD_CONSUME_MAX_PACKETS", 5);

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
  const error = new Error(`native worker exited before session backpressure completed. exit=${exitCode}. stderr=${stderr}`);
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
    ...(videoThreadLimit === undefined ? {} : { videoThreadLimit }),
    videoFrameQueueCapacity,
    audioIndex,
    audioPayloadQueueCapacity,
    startVideoThread: true,
    startAudioThread: true,
  });

  const samples = [];
  const consumeEvents = [];
  const startedAt = Date.now();
  let nextVideoConsumeAt = consumeVideoEveryMs > 0 ? startedAt + consumeVideoEveryMs : Number.POSITIVE_INFINITY;
  let nextAudioConsumeAt = consumeAudioEveryMs > 0 ? startedAt + consumeAudioEveryMs : Number.POSITIVE_INFINITY;

  while (Date.now() - startedAt < durationMs) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, sampleIntervalMs));
    const now = Date.now();

    if (now >= nextVideoConsumeAt) {
      try {
        consumeEvents.push({
          kind: "video",
          elapsedMs: now - startedAt,
          result: await request("consumeVideoPayloadQueue", { maxFrames: maxVideoFrames }),
        });
      } catch (error) {
        consumeEvents.push({ kind: "video", elapsedMs: now - startedAt, error: errorMessage(error) });
      }
      nextVideoConsumeAt = now + consumeVideoEveryMs;
    }

    if (now >= nextAudioConsumeAt) {
      try {
        consumeEvents.push({
          kind: "audio",
          elapsedMs: now - startedAt,
          result: await request("consumeAudioPayloadQueue", { maxPackets: maxAudioPackets }),
        });
      } catch (error) {
        consumeEvents.push({ kind: "audio", elapsedMs: now - startedAt, error: errorMessage(error) });
      }
      nextAudioConsumeAt = now + consumeAudioEveryMs;
    }

    samples.push(toBackpressureSample(await request("status")));
  }

  const stopped = await request("stop");
  assert(stopped.captureSession?.state === "idle", "worker stops after session backpressure profile");

  const summary = summarizeBackpressureProfile({
    mode: started.captureSession?.mode,
    boundVideoChannels: started.captureSession?.boundVideoChannels ?? 0,
    boundAudioEndpoints: started.captureSession?.boundAudioEndpoints ?? 0,
    videoFrameQueueCapacity,
    audioPayloadQueueCapacity,
    durationMs,
    sampleIntervalMs,
    consumeVideoEveryMs,
    consumeAudioEveryMs,
    samples,
    consumeEvents,
    stoppedState: stopped.captureSession?.state,
  });

  console.log(JSON.stringify(summary, null, 2));
  completed = true;
  await request("shutdown");
} finally {
  child.stdin.end();
  child.kill();
}

function toBackpressureSample(snapshot) {
  const videoThreads = getVideoThreads(snapshot.stats);
  const firstVideoThread = videoThreads[0] ?? null;
  const audioThread = snapshot.stats?.audioCaptureThread ?? null;
  return {
    elapsedMs: snapshot.stats?.elapsedMs ?? null,
    videoThreadCount: videoThreads.length,
    video: firstVideoThread
      ? {
          channelId: firstVideoThread.channelId,
          sampleCount: firstVideoThread.sampleCount ?? 0,
          queueDepth: firstVideoThread.frameQueue?.payloadQueue?.depth ?? 0,
          queueBytes: firstVideoThread.frameQueue?.payloadQueue?.bytes ?? 0,
          copyCount: firstVideoThread.frameQueue?.payloadQueue?.copyCount ?? 0,
          dropCount: firstVideoThread.frameQueue?.dropCount ?? 0,
          droppedBytes: firstVideoThread.frameQueue?.payloadQueue?.droppedBytes ?? 0,
          consumeCount: firstVideoThread.frameQueue?.payloadQueue?.consumeCount ?? 0,
          consumerStatus: firstVideoThread.frameQueue?.consumerStatus ?? "unknown",
        }
      : null,
    audio: audioThread
      ? {
          packetCount: audioThread.packetCount ?? 0,
          queueDepth: audioThread.payloadQueue?.depth ?? 0,
          queueBytes: audioThread.payloadQueue?.bytes ?? 0,
          copyCount: audioThread.payloadQueue?.copyCount ?? 0,
          dropCount: audioThread.payloadQueue?.dropCount ?? 0,
          droppedBytes: audioThread.payloadQueue?.droppedBytes ?? 0,
          consumeCount: audioThread.payloadQueue?.consumeCount ?? 0,
          consumerStatus: audioThread.payloadQueue?.consumerStatus ?? "unknown",
          levelStatus: audioThread.audioLevel?.status ?? "unknown",
          rms: numberOrNull(audioThread.audioLevel?.rms),
          peak: numberOrNull(audioThread.audioLevel?.peak),
        }
      : null,
  };
}

function summarizeBackpressureProfile(profile) {
  assert(profile.samples.length > 0, "backpressure profile collects at least one status sample");
  const videoSamples = profile.samples.map((sample) => sample.video).filter(Boolean);
  const audioSamples = profile.samples.map((sample) => sample.audio).filter(Boolean);
  const videoSummary = summarizeVideoBackpressure(videoSamples, profile.videoFrameQueueCapacity);
  const audioSummary = summarizeAudioBackpressure(audioSamples, profile.audioPayloadQueueCapacity);

  return {
    status: "passed",
    mode: profile.mode,
    durationMs: profile.durationMs,
    sampleIntervalMs: profile.sampleIntervalMs,
    sampleCount: profile.samples.length,
    boundVideoChannels: profile.boundVideoChannels,
    boundAudioEndpoints: profile.boundAudioEndpoints,
    videoFrameQueueCapacity: profile.videoFrameQueueCapacity,
    audioPayloadQueueCapacity: profile.audioPayloadQueueCapacity,
    consumeVideoEveryMs: profile.consumeVideoEveryMs,
    consumeAudioEveryMs: profile.consumeAudioEveryMs,
    video: videoSummary,
    audio: audioSummary,
    consumeEventCount: profile.consumeEvents.length,
    consumeEvents: profile.consumeEvents,
    stoppedState: profile.stoppedState,
  };
}

function summarizeVideoBackpressure(samples, capacity) {
  if (samples.length === 0) {
    return { status: "skipped", reason: "no-bound-video-thread" };
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  const maxDepth = max(samples.map((sample) => sample.queueDepth));
  assert(maxDepth <= capacity, `video payload queue depth ${maxDepth} exceeds capacity ${capacity}`);
  if (last.copyCount > capacity) {
    assert(last.dropCount > 0, "video payload queue drops after capacity is exceeded without a consumer");
  }
  return {
    status: "bounded",
    channelId: last.channelId,
    samplesProduced: last.sampleCount - first.sampleCount,
    copyDelta: last.copyCount - first.copyCount,
    dropCountEnd: last.dropCount,
    droppedBytesEnd: last.droppedBytes,
    maxDepth,
    maxBytes: max(samples.map((sample) => sample.queueBytes)),
    consumeCountEnd: last.consumeCount,
    consumerStatus: last.consumerStatus,
  };
}

function summarizeAudioBackpressure(samples, capacity) {
  if (samples.length === 0) {
    return { status: "skipped", reason: "no-bound-audio-thread" };
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  const maxDepth = max(samples.map((sample) => sample.queueDepth));
  assert(maxDepth <= capacity, `audio payload queue depth ${maxDepth} exceeds capacity ${capacity}`);
  if (last.copyCount > capacity) {
    assert(last.dropCount > 0, "audio payload queue drops after capacity is exceeded without a consumer");
  }
  return {
    status: "bounded",
    packetsProduced: last.packetCount - first.packetCount,
    copyDelta: last.copyCount - first.copyCount,
    dropCountEnd: last.dropCount,
    droppedBytesEnd: last.droppedBytes,
    maxDepth,
    maxBytes: max(samples.map((sample) => sample.queueBytes)),
    consumeCountEnd: last.consumeCount,
    consumerStatus: last.consumerStatus,
    levelStatus: last.levelStatus,
    rms: last.rms,
    peak: last.peak,
  };
}

function getVideoThreads(stats) {
  if (Array.isArray(stats?.videoCaptureThreads)) return stats.videoCaptureThreads;
  if (stats?.videoCaptureThread) return [stats.videoCaptureThread];
  return [];
}

function max(values) {
  return values.reduce((largest, value) => Math.max(largest, value), 0);
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
