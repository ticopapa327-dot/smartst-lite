import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = resolve(rootDir, "media-worker-poc/worker.mjs");
const child = spawn(process.execPath, [workerPath], {
  cwd: rootDir,
  stdio: ["pipe", "pipe", "pipe"],
});

const pending = new Map();
const events = [];
let buffer = "";

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex = buffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = buffer.slice(0, newlineIndex);
    buffer = buffer.slice(newlineIndex + 1);
    handleLine(line);
    newlineIndex = buffer.indexOf("\n");
  }
});

child.stderr.setEncoding("utf8");
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

try {
  await waitForEvent("worker", "ready");

  const devices = await request("listDevices");
  assert(devices.video.length === 4, "four mock video devices are listed");
  assert(devices.audio.length === 1, "one mock audio device is listed");

  const started = await request("start", {
    channels: ["field-camera", "endoscope"],
  });
  assert(started.state === "running", "worker starts");
  assert(started.channels.length === 2, "requested channels start");

  const status = await request("status");
  assert(status.state === "running", "status reports running");
  assert(status.channels[0].trackName === "video:field-camera", "track name is stable");

  const synthetic = await request("startSyntheticPublisher", {
    roomName: "lk-synthetic-poc",
    livekitUrl: "ws://127.0.0.1:7880",
    trackNames: ["video:synthetic-field", "audio:synthetic-room"],
  });
  assert(synthetic.livekit.state === "mock-publishing", "synthetic publisher starts");
  assert(synthetic.livekit.realPublisher === false, "synthetic publisher is explicitly mock");
  assert(synthetic.livekit.requiresNativeSdk === true, "native SDK requirement is explicit");
  assert(synthetic.livekit.publishedTrackNames.length === 2, "synthetic tracks are named");

  const stoppedPublisher = await request("stopSyntheticPublisher");
  assert(stoppedPublisher.livekit.state === "idle", "synthetic publisher stops");

  const stopped = await request("stop");
  assert(stopped.state === "idle", "worker stops");
  assert(stopped.channels.length === 0, "channels clear after stop");

  const restarted = await request("start");
  assert(restarted.state === "running", "worker restarts");
  assert(restarted.channels.length === 4, "default channels start");

  await request("stop");
  await request("shutdown");

  assert(hasEvent("device", "snapshot"), "device event emitted");
  assert(hasEvent("channel", "started"), "channel started event emitted");
  assert(hasEvent("recording", "state"), "recording event emitted");
  assert(hasEvent("livekit", "state"), "livekit event emitted");
  assert(hasEvent("livekit", "publisher-started"), "synthetic publisher event emitted");
  assert(hasEvent("livekit", "publisher-stopped"), "synthetic publisher stopped event emitted");

  console.log("media-worker-poc smoke passed");
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
    }, 5000);
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
    handler.reject(new Error(message.error?.message || "worker response failed"));
  }
}

function waitForEvent(category, name) {
  if (hasEvent(category, name)) {
    return Promise.resolve();
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (hasEvent(category, name)) {
        clearInterval(timer);
        resolvePromise();
        return;
      }
      if (Date.now() - startedAt > 5000) {
        clearInterval(timer);
        rejectPromise(new Error(`event ${category}.${name} timed out. stderr=${stderr}`));
      }
    }, 20);
  });
}

function hasEvent(category, name) {
  return events.some((event) => event.category === category && event.name === name);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
