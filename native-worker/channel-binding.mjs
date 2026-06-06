import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(rootDir, "native-worker/Cargo.toml");

const videoIndex = readIntegerEnv("UST_NATIVE_VIDEO_INDEX", 0);
const holdMs = readIntegerEnv("UST_NATIVE_SESSION_HOLD_MS", 500);

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
  const error = new Error(`native worker exited before channel binding smoke completed. exit=${exitCode}. stderr=${stderr}`);
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

  const devices = await request("listDevices");
  const selectedVideo = devices.video?.find((device) => device.index === videoIndex) ?? devices.video?.[0];
  if (!selectedVideo) {
    completed = true;
    console.log(
      JSON.stringify(
        {
          status: "skipped",
          reason: "no-video-device",
          videoCount: devices.video?.length ?? 0,
        },
        null,
        2,
      ),
    );
    await request("shutdown");
  } else {
    const selector = {
      index: selectedVideo.index,
      deviceId: selectedVideo.deviceId,
    };
    const started = await request("start", {
      channels: ["field-camera"],
      videoChannelBindings: {
        "field-camera": selector,
      },
      startVideoThread: true,
      startAudioThread: false,
      videoFrameQueueCapacity: 3,
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, holdMs));
    const status = await request("status");
    const channel = started.channels?.[0];
    const binding = channel?.deviceBinding;
    const thread = getVideoThreads(status.stats)[0];

    assert(started.captureSession?.videoChannelBindings?.["field-camera"]?.index === selectedVideo.index, "session echoes channel binding index");
    assert(binding?.mode === "explicit", "channel binding uses explicit mode");
    assert(binding?.selectedIndex === selectedVideo.index, "channel binding selected expected video index");
    assert(channel?.device?.deviceId === selectedVideo.deviceId, "channel binds expected deviceId");
    assert(thread?.device?.deviceId === selectedVideo.deviceId, "capture thread uses bound deviceId");
    assert(thread?.frameQueue?.payloadQueue?.copyCount > 0, "capture thread copies payload frames after explicit channel binding");

    const stopped = await request("stop");
    assert(stopped.captureSession?.state === "idle", "worker stops after channel binding smoke");
    completed = true;
    console.log(
      JSON.stringify(
        {
          status: "passed",
          mode: started.captureSession?.mode,
          selector,
          selectedIndex: binding.selectedIndex,
          selectedDeviceId: binding.selectedDeviceId,
          channelId: channel.channelId,
          copiedFrames: thread.frameQueue.payloadQueue.copyCount,
          stoppedState: stopped.captureSession?.state,
        },
        null,
        2,
      ),
    );
    await request("shutdown");
  }
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
