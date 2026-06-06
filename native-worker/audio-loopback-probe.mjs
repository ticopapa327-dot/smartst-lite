import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(rootDir, "native-worker/Cargo.toml");

const audioRenderIndex = readIntegerEnv("UST_NATIVE_AUDIO_RENDER_INDEX", 0);
const durationMs = readIntegerEnv("UST_NATIVE_LOOPBACK_DURATION_MS", 500);
const pollIntervalMs = readIntegerEnv("UST_NATIVE_LOOPBACK_POLL_INTERVAL_MS", 10);

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
  const error = new Error(`native worker exited before audio loopback probe completed. exit=${exitCode}. stderr=${stderr}`);
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

  const loopback = await request(
    "captureAudioLoopbackBuffer",
    {
      index: audioRenderIndex,
      durationMs,
      pollIntervalMs,
    },
    Math.max(30000, durationMs + 15000),
  );

  assert(["loopback-captured", "no-loopback-packets"].includes(loopback.status), "loopback status is explicit");
  assert(loopback.device?.dataFlow === "render", "loopback source device is a render endpoint");
  assert(loopback.loopbackSource === "render", "loopback source is explicit");
  assert(loopback.loopbackClientStatus === "opened-stopped", "loopback client opens and stops");
  assert(loopback.audibleOutputGenerated === false, "loopback probe does not generate audio output");
  assert(loopback.aecStatus === "not-run", "loopback probe does not claim AEC");
  assert(Number.isFinite(loopback.pollCount) && loopback.pollCount > 0, "loopback poll count is reported");
  assert(Number.isFinite(loopback.packetCount), "loopback packet count is reported");
  assert(Number.isFinite(loopback.capturedFrames), "loopback captured frames are reported");

  completed = true;
  console.log(JSON.stringify({ status: "passed", audioRenderIndex, loopback }, null, 2));
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
