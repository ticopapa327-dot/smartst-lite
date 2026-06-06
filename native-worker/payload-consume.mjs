import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(rootDir, "native-worker/Cargo.toml");

const channels = (process.env.SMARTST_NATIVE_SESSION_CHANNELS || "field-camera,endoscope")
  .split(",")
  .map((channel) => channel.trim())
  .filter(Boolean);
const videoMediaTypeIndex = readIntegerEnv("SMARTST_NATIVE_VIDEO_MEDIA_TYPE_INDEX", 0);
const videoThreadLimit = readIntegerEnv("SMARTST_NATIVE_VIDEO_THREAD_LIMIT", undefined);
const videoFrameQueueCapacity = readIntegerEnv("SMARTST_NATIVE_VIDEO_FRAME_QUEUE_CAPACITY", 3);
const holdMs = readIntegerEnv("SMARTST_NATIVE_SESSION_HOLD_MS", 1000);
const maxFrames = readIntegerEnv("SMARTST_NATIVE_VIDEO_PAYLOAD_CONSUME_MAX_FRAMES", 2);

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
  const error = new Error(`native worker exited before payload consume completed. exit=${exitCode}. stderr=${stderr}`);
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
    startVideoThread: true,
    startAudioThread: false,
  });

  await new Promise((resolve) => setTimeout(resolve, holdMs));
  const before = await request("status");
  const videoThreads = getVideoThreads(before.stats);
  const firstThread = videoThreads[0];
  let summary;

  if ((started.captureSession?.boundVideoChannels ?? 0) > 0) {
    assert(firstThread, "video thread is available before consume");
    assert(firstThread.frameQueue?.payloadQueue?.copyCount > 0, "payload queue has copied frames before consume");
    assert(firstThread.frameQueue.payloadQueue.bytes > 0, "payload queue has native bytes before consume");

    const consumed = await request("consumeVideoPayloadQueue", {
      channelId: firstThread.channelId,
      maxFrames,
    });
    assert(consumed.exportedOverJson === false, "payload consume does not export frame bytes");
    assert(consumed.payloadTransport === "native-only", "payload consume stays native-only");
    assert(consumed.channelId === firstThread.channelId, "payload consume drains the requested channel");
    assert(consumed.consumedFrames > 0, "payload consume drains at least one frame");
    assert(consumed.consumedBytes > 0, "payload consume accounts for bytes");
    assert(consumed.remainingDepth <= firstThread.frameQueue.payloadQueue.depth, "payload consume reduces or bounds queue depth");

    const after = await request("status");
    assert(after.stats?.videoPayloadConsumeCount >= consumed.consumedFrames, "payload consume aggregate is updated");
    assert(after.stats?.videoPayloadConsumedBytes >= consumed.consumedBytes, "payload consumed bytes aggregate is updated");
    assert(getVideoThreads(after.stats)[0]?.frameQueue?.consumerStatus === "manual-drain", "payload consumer status is visible");

    summary = {
      status: "passed",
      mode: started.captureSession?.mode,
      boundVideoChannels: started.captureSession?.boundVideoChannels,
      requestedChannelId: firstThread.channelId,
      channelId: firstThread.channelId,
      copiedFrames: before.stats?.videoPayloadCopyCount ?? 0,
      queuedBytesBefore: before.stats?.videoPayloadQueueBytes ?? 0,
      consumedFrames: consumed.consumedFrames,
      consumedBytes: consumed.consumedBytes,
      remainingDepth: consumed.remainingDepth,
      queuedBytesAfter: after.stats?.videoPayloadQueueBytes ?? 0,
      consumerStatus: getVideoThreads(after.stats)[0]?.frameQueue?.consumerStatus ?? null,
      exportedOverJson: consumed.exportedOverJson,
    };
  } else {
    summary = {
      status: "skipped",
      reason: "no-bound-video-channel",
      mode: started.captureSession?.mode,
      boundVideoChannels: started.captureSession?.boundVideoChannels ?? 0,
    };
  }

  const stopped = await request("stop");
  assert(stopped.captureSession?.state === "idle", "worker stops after payload consume");
  console.log(JSON.stringify({ ...summary, stoppedState: stopped.captureSession?.state }, null, 2));
  completed = true;
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
