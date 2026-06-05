import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(rootDir, "native-worker/Cargo.toml");

const channels = (process.env.SMARTST_NATIVE_SESSION_CHANNELS || "field-camera")
  .split(",")
  .map((channel) => channel.trim())
  .filter(Boolean);
const audioIndex = readIntegerEnv("SMARTST_NATIVE_AUDIO_INDEX", 0);
const audioPayloadQueueCapacity = readIntegerEnv("SMARTST_NATIVE_AUDIO_PAYLOAD_QUEUE_CAPACITY", 50);
const holdMs = readIntegerEnv("SMARTST_NATIVE_SESSION_HOLD_MS", 1000);
const maxPackets = readIntegerEnv("SMARTST_NATIVE_AUDIO_PAYLOAD_CONSUME_MAX_PACKETS", 5);

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
  const error = new Error(`native worker exited before audio payload consume completed. exit=${exitCode}. stderr=${stderr}`);
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
    audioIndex,
    audioPayloadQueueCapacity,
    startVideoThread: false,
    startAudioThread: true,
  });

  await new Promise((resolve) => setTimeout(resolve, holdMs));
  const before = await request("status");
  const audioThread = before.stats?.audioCaptureThread;
  let summary;

  if ((started.captureSession?.boundAudioEndpoints ?? 0) > 0) {
    assert(audioThread, "audio thread is available before consume");
    assert(audioThread.payloadQueue?.mode === "pcm-packet-bounded", "audio payload queue mode is reported");
    assert(audioThread.payloadQueue?.copyCount > 0, "audio payload queue has copied packets before consume");
    assert(audioThread.payloadQueue?.bytes > 0, "audio payload queue has native PCM bytes before consume");

    const consumed = await request("consumeAudioPayloadQueue", {
      maxPackets,
    });
    assert(consumed.exportedOverJson === false, "audio payload consume does not export PCM bytes");
    assert(consumed.payloadTransport === "native-only", "audio payload consume stays native-only");
    assert(consumed.consumedPackets > 0, "audio payload consume drains at least one packet");
    assert(consumed.consumedBytes > 0, "audio payload consume accounts for bytes");
    assert(consumed.remainingDepth <= audioThread.payloadQueue.depth, "audio payload consume reduces or bounds queue depth");

    const after = await request("status");
    assert(after.stats?.audioPayloadConsumeCount >= consumed.consumedPackets, "audio payload consume aggregate is updated");
    assert(after.stats?.audioPayloadConsumedBytes >= consumed.consumedBytes, "audio payload consumed bytes aggregate is updated");
    assert(after.stats?.audioCaptureThread?.payloadQueue?.consumerStatus === "manual-drain", "audio payload consumer status is visible");

    summary = {
      status: "passed",
      mode: started.captureSession?.mode,
      boundAudioEndpoints: started.captureSession?.boundAudioEndpoints,
      copiedPackets: before.stats?.audioPayloadCopyCount ?? 0,
      queuedBytesBefore: before.stats?.audioPayloadQueueBytes ?? 0,
      consumedPackets: consumed.consumedPackets,
      consumedBytes: consumed.consumedBytes,
      remainingDepth: consumed.remainingDepth,
      queuedBytesAfter: after.stats?.audioPayloadQueueBytes ?? 0,
      consumerStatus: after.stats?.audioCaptureThread?.payloadQueue?.consumerStatus ?? null,
      exportedOverJson: consumed.exportedOverJson,
    };
  } else {
    summary = {
      status: "skipped",
      reason: "no-bound-audio-endpoint",
      mode: started.captureSession?.mode,
      boundAudioEndpoints: started.captureSession?.boundAudioEndpoints ?? 0,
    };
  }

  const stopped = await request("stop");
  assert(stopped.captureSession?.state === "idle", "worker stops after audio payload consume");
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
