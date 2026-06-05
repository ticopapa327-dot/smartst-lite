import { spawn } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, parsePpm } from "./export-artifact-utils.mjs";

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
const maxFrames = readIntegerEnv("SMARTST_NATIVE_VIDEO_PPM_EXPORT_MAX_FRAMES", 1);
const outputPath = resolve(
  rootDir,
  process.env.SMARTST_NATIVE_VIDEO_PPM_EXPORT_PATH || "native-worker/.tmp/video-payload-export.ppm",
);

await mkdir(dirname(outputPath), { recursive: true });

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
  const error = new Error(`native worker exited before video PPM export completed. exit=${exitCode}. stderr=${stderr}`);
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

  await new Promise((resolvePromise) => setTimeout(resolvePromise, holdMs));
  const before = await request("status");
  const firstThread = getVideoThreads(before.stats)[0];
  let summary;

  if ((started.captureSession?.boundVideoChannels ?? 0) > 0) {
    assert(firstThread?.frameQueue?.payloadQueue?.copyCount > 0, "video payload queue has copied frames before PPM export");
    const exported = await request("exportVideoPayloadQueuePpm", {
      channelId: firstThread.channelId,
      path: outputPath,
      maxFrames,
      overwrite: true,
    });
    assert(exported.status === "exported", "video PPM export reports exported status");
    assert(exported.exportedOverJson === false, "video PPM export does not export frame bytes over JSON");
    assert(exported.payloadTransport === "native-only", "video PPM export stays native-only");
    assert(exported.consumedFrames > 0, "video PPM export drains frames");
    assert(exported.fileBytes > 0, "video PPM export writes file bytes");

    const fileStat = await stat(outputPath);
    const fileBytes = await readFile(outputPath);
    const ppm = parsePpm(fileBytes);
    assert(fileStat.size === exported.fileBytes, "video PPM fileBytes matches stat size");
    assert(ppm.width === exported.imageFormat.width, "video PPM width matches export metadata");
    assert(ppm.height === exported.imageFormat.height, "video PPM height matches export metadata");
    assert(ppm.fileBytes === fileStat.size, "video PPM parsed file size matches stat size");

    const after = await request("status");
    assert(after.stats?.videoPayloadConsumeCount >= exported.consumedFrames, "video PPM export updates consume count");
    assert(getVideoThreads(after.stats)[0]?.frameQueue?.consumerStatus === "ppm-export", "video PPM export consumer status is visible");

    summary = {
      status: "passed",
      mode: started.captureSession?.mode,
      boundVideoChannels: started.captureSession?.boundVideoChannels,
      channelId: firstThread.channelId,
      copiedFrames: before.stats?.videoPayloadCopyCount ?? 0,
      exportedFrames: exported.consumedFrames,
      exportedBytes: exported.consumedBytes,
      fileBytes: fileStat.size,
      path: outputPath,
      ppm,
      imageFormat: exported.imageFormat,
      queuedBytesAfter: after.stats?.videoPayloadQueueBytes ?? 0,
      consumerStatus: getVideoThreads(after.stats)[0]?.frameQueue?.consumerStatus ?? null,
      exportedOverJson: exported.exportedOverJson,
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
  assert(stopped.captureSession?.state === "idle", "worker stops after video PPM export");
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
