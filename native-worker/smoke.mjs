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
  assert(devices.video.length === 4, "four mock video devices are listed");
  assert(devices.audio.length === 1, "one mock audio device is listed");

  const started = await request("start", {
    channels: ["field-camera", "endoscope"],
  });
  assert(started.state === "running", "worker starts");
  assert(started.channels.length === 2, "requested channels start");
  assert(started.channels[0].source === "mock-native", "native mock source is explicit");

  const status = await request("status");
  assert(status.state === "running", "status reports running");
  assert(status.livekit.requiresNativeSdk === true, "native SDK boundary is explicit");

  const stopped = await request("stop");
  assert(stopped.state === "idle", "worker stops");
  assert(stopped.channels.length === 0, "channels clear after stop");

  await request("shutdown");

  assert(hasEvent("device", "snapshot"), "device event emitted");
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
