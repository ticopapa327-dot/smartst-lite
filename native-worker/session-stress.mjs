import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(rootDir, "native-worker/Cargo.toml");

const channels = (process.env.UST_NATIVE_SESSION_CHANNELS || "field-camera,endoscope")
  .split(",")
  .map((channel) => channel.trim())
  .filter(Boolean);
const iterations = readIntegerEnv("UST_NATIVE_SESSION_STRESS_ITERATIONS", 3);
const holdMs = readIntegerEnv("UST_NATIVE_SESSION_HOLD_MS", 1000);
const videoMediaTypeIndex = readIntegerEnv("UST_NATIVE_VIDEO_MEDIA_TYPE_INDEX", 0);
const videoThreadLimit = readIntegerEnv("UST_NATIVE_VIDEO_THREAD_LIMIT", undefined);
const videoFrameQueueCapacity = readIntegerEnv("UST_NATIVE_VIDEO_FRAME_QUEUE_CAPACITY", undefined);
const audioIndex = readIntegerEnv("UST_NATIVE_AUDIO_INDEX", 0);
const audioPayloadQueueCapacity = readIntegerEnv("UST_NATIVE_AUDIO_PAYLOAD_QUEUE_CAPACITY", undefined);

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
  const error = new Error(`native worker exited before session stress completed. exit=${exitCode}. stderr=${stderr}`);
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

  const results = [];
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const started = await request("start", {
      channels,
      videoMediaTypeIndex,
      ...(videoThreadLimit === undefined ? {} : { videoThreadLimit }),
      ...(videoFrameQueueCapacity === undefined ? {} : { videoFrameQueueCapacity }),
      audioIndex,
      ...(audioPayloadQueueCapacity === undefined ? {} : { audioPayloadQueueCapacity }),
      startVideoThread: true,
      startAudioThread: true,
    });
    assert(started.state === "running", `iteration ${iteration}: worker starts`);
    assert(started.captureSession?.state === "running", `iteration ${iteration}: capture session starts`);

    await new Promise((resolve) => setTimeout(resolve, holdMs));
    const status = await request("status");
    assert(status.state === "running", `iteration ${iteration}: status running`);
    const videoThreads = getVideoThreads(status.stats);
    const audioThread = status.stats?.audioCaptureThread;
    if (started.captureSession?.boundVideoChannels > 0) {
      assert(videoThreads.length > 0, `iteration ${iteration}: video threads reported`);
      assert(status.stats?.videoCaptureThreadCount === videoThreads.length, `iteration ${iteration}: video thread count matches`);
      for (const thread of videoThreads) {
        assert(thread.state === "running", `iteration ${iteration}: video thread ${thread.channelId} running`);
        assert(thread.sampleCount > 0, `iteration ${iteration}: video samples captured on ${thread.channelId}`);
        assert(thread.frameQueue?.mode === "native-payload-bounded", `iteration ${iteration}: frame queue mode reported on ${thread.channelId}`);
        assert(thread.frameQueue.pushCount === thread.sampleCount, `iteration ${iteration}: frame queue push count matches samples on ${thread.channelId}`);
        assert(thread.frameQueue.depth <= thread.frameQueue.capacity, `iteration ${iteration}: frame queue depth bounded on ${thread.channelId}`);
        assert(thread.frameQueue.payloadQueue?.mode === "copied-bounded", `iteration ${iteration}: payload queue mode reported on ${thread.channelId}`);
        assert(thread.frameQueue.payloadQueue.exportedOverJson === false, `iteration ${iteration}: payload is not exported through JSON on ${thread.channelId}`);
        assert(thread.frameQueue.payloadQueue.copyCount === thread.frameQueue.pushCount, `iteration ${iteration}: payload copy count matches pushes on ${thread.channelId}`);
        assert(thread.frameQueue.payloadQueue.copyErrorCount === 0, `iteration ${iteration}: payload copy has no errors on ${thread.channelId}`);
        assert(thread.frameQueue.payloadQueue.depth <= thread.frameQueue.capacity, `iteration ${iteration}: payload queue depth bounded on ${thread.channelId}`);
        assert(thread.frameQueue.payloadQueue.bytes > 0, `iteration ${iteration}: payload queue keeps native bytes on ${thread.channelId}`);
      }
      assert(status.stats?.videoPayloadCopyCount === status.stats?.videoFrameQueuePushCount, `iteration ${iteration}: payload copy aggregate matches pushes`);
      assert(status.stats?.videoPayloadCopyErrorCount === 0, `iteration ${iteration}: payload copy aggregate has no errors`);
      assert(status.stats?.videoPayloadQueueBytes > 0, `iteration ${iteration}: payload queue aggregate keeps native bytes`);
    }
    if (started.captureSession?.boundAudioEndpoints > 0) {
      assert(audioThread?.state === "running", `iteration ${iteration}: audio thread running`);
      assert(audioThread.packetCount > 0, `iteration ${iteration}: audio packets captured`);
      assert(audioThread.payloadQueue?.mode === "pcm-packet-bounded", `iteration ${iteration}: audio payload queue mode reported`);
      assert(audioThread.payloadQueue.copyCount === audioThread.packetCount, `iteration ${iteration}: audio payload copy count matches packets`);
      assert(audioThread.payloadQueue.copyErrorCount === 0, `iteration ${iteration}: audio payload copy has no errors`);
      assert(audioThread.payloadQueue.bytes > 0, `iteration ${iteration}: audio payload queue keeps native bytes`);
      assert(audioThread.audioLevel, `iteration ${iteration}: audio level stats reported`);
      assert(["measured", "unsupported-format"].includes(audioThread.audioLevel.status), `iteration ${iteration}: audio level status terminal`);
      if (audioThread.audioLevel.status === "measured") {
        assert(audioThread.audioLevel.sampleCount > 0, `iteration ${iteration}: audio level samples measured`);
        assert(audioThread.audioLevel.rms !== null, `iteration ${iteration}: audio RMS reported`);
        assert(audioThread.audioLevel.peak >= 0, `iteration ${iteration}: audio peak reported`);
      }
    }

    const stopped = await request("stop");
    assert(stopped.state === "idle", `iteration ${iteration}: worker stops`);
    assert(stopped.captureSession?.state === "idle", `iteration ${iteration}: capture session clears`);
    assert(stopped.stats?.realMediaSession === false, `iteration ${iteration}: stats reset`);

    results.push({
      iteration,
      holdMs,
      mode: started.captureSession?.mode,
      boundVideoChannels: started.captureSession?.boundVideoChannels,
      videoThreadCount: videoThreads.length,
      boundAudioEndpoints: started.captureSession?.boundAudioEndpoints,
      videoStates: videoThreads.map((thread) => ({
        channelId: thread.channelId,
        state: thread.state,
        sampleCount: thread.sampleCount ?? 0,
        measuredFps: thread.measuredFps ?? null,
        frameQueue: thread.frameQueue ?? null,
      })),
      videoSamples: sumBy(videoThreads, "sampleCount"),
      videoFrameQueuePushCount: status.stats?.videoFrameQueuePushCount ?? 0,
      videoFrameQueueDropCount: status.stats?.videoFrameQueueDropCount ?? 0,
      videoPayloadCopyCount: status.stats?.videoPayloadCopyCount ?? 0,
      videoPayloadQueueBytes: status.stats?.videoPayloadQueueBytes ?? 0,
      audioState: audioThread?.state ?? null,
      audioPackets: audioThread?.packetCount ?? 0,
      audioFrames: audioThread?.capturedFrames ?? 0,
      audioPayloadCopyCount: audioThread?.payloadQueue?.copyCount ?? 0,
      audioPayloadQueueBytes: audioThread?.payloadQueue?.bytes ?? 0,
      audioLevel: audioThread?.audioLevel ?? null,
      stoppedState: stopped.captureSession?.state,
    });
  }

  completed = true;
  console.log(JSON.stringify({ iterations, holdMs, results }, null, 2));
  await request("shutdown");
} finally {
  child.stdin.end();
  child.kill();
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

function getVideoThreads(stats) {
  if (Array.isArray(stats?.videoCaptureThreads)) return stats.videoCaptureThreads;
  if (stats?.videoCaptureThread) return [stats.videoCaptureThread];
  return [];
}

function sumBy(items, key) {
  return items.reduce((total, item) => total + (Number.isFinite(item?.[key]) ? item[key] : 0), 0);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
