import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(rootDir, "native-worker/Cargo.toml");

const channels = (process.env.SMARTST_NATIVE_SESSION_CHANNELS || "field-camera,endoscope")
  .split(",")
  .map((channel) => channel.trim())
  .filter(Boolean);
const iterations = readIntegerEnv("SMARTST_NATIVE_SESSION_STRESS_ITERATIONS", 3);
const holdMs = readIntegerEnv("SMARTST_NATIVE_SESSION_HOLD_MS", 1000);
const videoMediaTypeIndex = readIntegerEnv("SMARTST_NATIVE_VIDEO_MEDIA_TYPE_INDEX", 0);
const audioIndex = readIntegerEnv("SMARTST_NATIVE_AUDIO_INDEX", 0);

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
      audioIndex,
      startVideoThread: true,
      startAudioThread: true,
    });
    assert(started.state === "running", `iteration ${iteration}: worker starts`);
    assert(started.captureSession?.state === "running", `iteration ${iteration}: capture session starts`);

    await new Promise((resolve) => setTimeout(resolve, holdMs));
    const status = await request("status");
    assert(status.state === "running", `iteration ${iteration}: status running`);
    const videoThread = status.stats?.videoCaptureThread;
    const audioThread = status.stats?.audioCaptureThread;
    if (started.captureSession?.boundVideoChannels > 0) {
      assert(videoThread?.state === "running", `iteration ${iteration}: video thread running`);
      assert(videoThread.sampleCount > 0, `iteration ${iteration}: video samples captured`);
    }
    if (started.captureSession?.boundAudioEndpoints > 0) {
      assert(audioThread?.state === "running", `iteration ${iteration}: audio thread running`);
      assert(audioThread.packetCount > 0, `iteration ${iteration}: audio packets captured`);
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
      boundAudioEndpoints: started.captureSession?.boundAudioEndpoints,
      videoState: videoThread?.state ?? null,
      videoSamples: videoThread?.sampleCount ?? 0,
      videoMeasuredFps: videoThread?.measuredFps ?? null,
      audioState: audioThread?.state ?? null,
      audioPackets: audioThread?.packetCount ?? 0,
      audioFrames: audioThread?.capturedFrames ?? 0,
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
