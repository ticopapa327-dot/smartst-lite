import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executableName = process.platform === "win32" ? "ust-native-worker.exe" : "ust-native-worker";
const workerPath = resolve(rootDir, "src-tauri/target/release/bin", executableName);

assert(existsSync(workerPath), `release worker is missing: ${workerPath}`);

const child = spawn(workerPath, [], {
  cwd: dirname(workerPath),
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
  assert(Array.isArray(devices.audioRender), "audio render devices are listed as an array");
  assert(devices.diagnostics?.workerDeviceMode, "device diagnostics include worker mode");
  assert(devices.diagnostics?.mediaFoundation?.status, "Media Foundation status is reported");
  assert(devices.diagnostics?.wasapi?.status, "WASAPI status is reported");
  assert(devices.diagnostics?.wasapiRender?.status, "WASAPI render status is reported");

  await request("shutdown");

  const result = {
    status: "passed",
    workerPath,
    source: devices.source,
    videoCount: devices.video.length,
    audioCount: devices.audio.length,
    audioRenderCount: devices.audioRender.length,
    diagnostics: {
      workerDeviceMode: devices.diagnostics.workerDeviceMode,
      mediaFoundationStatus: devices.diagnostics.mediaFoundation.status,
      wasapiStatus: devices.diagnostics.wasapi.status,
      wasapiRenderStatus: devices.diagnostics.wasapiRender.status,
    },
  };
  console.log(JSON.stringify(result, null, 2));
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
