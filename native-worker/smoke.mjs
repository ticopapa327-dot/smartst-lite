import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(rootDir, "native-worker/Cargo.toml");
const child = spawn("cargo", ["run", "--quiet", "--manifest-path", manifestPath], {
  cwd: rootDir,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

const pending = new Map();
const events = [];
let stdoutBuffer = "";
let stderr = "";

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

try {
  await waitForEvent("worker", "ready");

  const devices = await request("listDevices");
  assert(["windows-native", "mock-fallback", "mock-native"].includes(devices.source), "device source is explicit");
  assert(Array.isArray(devices.video), "video devices are listed as an array");
  assert(Array.isArray(devices.audio), "audio devices are listed as an array");
  assert(devices.diagnostics?.workerDeviceMode, "device diagnostics include worker mode");
  assert(devices.diagnostics?.mediaFoundation?.status, "Media Foundation status is reported");
  assert(devices.diagnostics?.wasapi?.status, "WASAPI status is reported");
  if (devices.video.length > 0) {
    assert(devices.video[0].backend, "video device backend is explicit");
    assert(devices.video[0].nativeId, "video device native id is present");
    assert(devices.video[0].capabilityProbeRequired === true || devices.source !== "windows-native", "video capability boundary is explicit");
  }
  if (devices.audio.length > 0) {
    assert(devices.audio[0].backend, "audio device backend is explicit");
    assert(devices.audio[0].nativeId, "audio device native id is present");
  }

  const started = await request("start", {
    channels: ["field-camera", "endoscope"],
  });
  assert(started.state === "running", "worker starts");
  assert(started.channels.length === 2, "requested channels start");
  assert(typeof started.channels[0].source === "string", "channel source is explicit");
  assert(started.captureSession?.state === "running", "capture session starts");
  assert(["windows-native", "mock-fallback"].includes(started.captureSession?.mode), "capture session mode is explicit");
  assert(started.captureSession?.mediaPayloadTransport, "capture session media transport boundary is explicit");

  const status = await request("status");
  assert(status.state === "running", "status reports running");
  assert(status.captureSession?.state === "running", "status reports capture session");
  if (started.captureSession?.boundVideoChannels > 0) {
    const videoThreads = getVideoThreads(status.stats);
    assert(videoThreads.length > 0, "status reports video capture thread stats");
    assert(status.stats.videoCaptureThread, "status keeps first video capture thread for compatibility");
    assert(status.stats.videoCaptureThreadCount === videoThreads.length, "video thread count matches stats array");
    for (const thread of videoThreads) {
      assert(["starting", "initializing", "running", "stopped", "failed"].includes(thread.state), "video thread state is explicit");
      assert(thread.channelId, "video thread channel id is reported");
      assert(Number.isInteger(thread.deviceIndex), "video thread device index is reported");
      assert(thread.frameQueue?.mode === "metadata-only-bounded", "video frame queue boundary is explicit");
      assert(thread.frameQueue.payloadTransport === "native-only", "video frame queue keeps payload native-only");
      assert(Number.isInteger(thread.frameQueue.capacity), "video frame queue capacity is reported");
    }
    assert(Number.isInteger(status.stats.videoFrameQueuePushCount), "video frame queue push aggregate is reported");
    assert(Number.isInteger(status.stats.videoFrameQueueDropCount), "video frame queue drop aggregate is reported");
  }
  if (started.captureSession?.boundAudioEndpoints > 0) {
    assert(status.stats?.audioCaptureThread, "status reports audio capture thread stats");
    assert(["starting", "initializing", "running", "stopped", "failed"].includes(status.stats.audioCaptureThread.state), "audio thread state is explicit");
  }
  assert(status.livekit.requiresNativeSdk === true, "native SDK boundary is explicit");

  const stopped = await request("stop");
  assert(stopped.state === "idle", "worker stops");
  assert(stopped.captureSession?.state === "idle", "capture session clears after stop");
  assert(stopped.channels.length === 0, "channels clear after stop");

  await request("shutdown");

  assert(hasEvent("device", "snapshot"), "device event emitted");
  assert(hasEvent("capture", "session-started"), "capture session started event emitted");
  assert(hasEvent("capture", "session-stopped"), "capture session stopped event emitted");
  if (started.captureSession?.boundVideoChannels > 0) {
    assert(hasEvent("video", "capture-thread-started"), "video thread started event emitted");
    assert(hasEvent("video", "capture-thread-stopped"), "video thread stopped event emitted");
  }
  if (started.captureSession?.boundAudioEndpoints > 0) {
    assert(hasEvent("audio", "capture-thread-started"), "audio thread started event emitted");
    assert(hasEvent("audio", "capture-thread-stopped"), "audio thread stopped event emitted");
  }
  assert(hasEvent("channel", "started"), "channel started event emitted");
  assert(hasEvent("recording", "state"), "recording event emitted");
  assert(hasEvent("livekit", "state"), "livekit event emitted");

  console.log("native-worker smoke passed");
} finally {
  child.stdin.end();
  child.kill();
}

function request(method, params) {
  const id = `${Date.now()}-${Math.random()}`;
  const payload = {
    id,
    method,
    ...(params ? { params } : {}),
  };

  const result = new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      rejectPromise(new Error(`${method} timed out. stderr=${stderr}`));
    }, 20000);
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

  child.stdin.write(`${JSON.stringify(payload)}\n`);
  return result;
}

function handleLine(line) {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.type === "event") {
    events.push(message.event);
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

function waitForEvent(category, name) {
  if (hasEvent(category, name)) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (hasEvent(category, name)) {
        clearInterval(timer);
        resolvePromise();
        return;
      }
      if (Date.now() - startedAt > 20000) {
        clearInterval(timer);
        rejectPromise(new Error(`event ${category}.${name} timed out. stderr=${stderr}`));
      }
    }, 20);
  });
}

function hasEvent(category, name) {
  return events.some((event) => event.category === category && event.name === name);
}

function getVideoThreads(stats) {
  if (Array.isArray(stats?.videoCaptureThreads)) return stats.videoCaptureThreads;
  if (stats?.videoCaptureThread) return [stats.videoCaptureThread];
  return [];
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
