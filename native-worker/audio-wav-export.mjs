import { spawn } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, parseWavHeader } from "./export-artifact-utils.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(rootDir, "native-worker/Cargo.toml");

const channels = (process.env.UST_NATIVE_SESSION_CHANNELS || "field-camera")
  .split(",")
  .map((channel) => channel.trim())
  .filter(Boolean);
const audioIndex = readIntegerEnv("UST_NATIVE_AUDIO_INDEX", 0);
const audioPayloadQueueCapacity = readIntegerEnv("UST_NATIVE_AUDIO_PAYLOAD_QUEUE_CAPACITY", 50);
const holdMs = readIntegerEnv("UST_NATIVE_SESSION_HOLD_MS", 1000);
const maxPackets = readIntegerEnv("UST_NATIVE_AUDIO_WAV_EXPORT_MAX_PACKETS", 10);
const outputPath = resolve(
  rootDir,
  process.env.UST_NATIVE_AUDIO_WAV_EXPORT_PATH || "native-worker/.tmp/audio-payload-export.wav",
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
  const error = new Error(`native worker exited before audio WAV export completed. exit=${exitCode}. stderr=${stderr}`);
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

  await new Promise((resolvePromise) => setTimeout(resolvePromise, holdMs));
  const before = await request("status");
  const audioThread = before.stats?.audioCaptureThread;
  let summary;

  if ((started.captureSession?.boundAudioEndpoints ?? 0) > 0) {
    assert(audioThread?.payloadQueue?.copyCount > 0, "audio payload queue has copied packets before WAV export");
    const exported = await request("exportAudioPayloadQueueWav", {
      path: outputPath,
      maxPackets,
      overwrite: true,
    });
    assert(exported.status === "exported", "audio WAV export reports exported status");
    assert(exported.exportedOverJson === false, "audio WAV export does not export PCM over JSON");
    assert(exported.payloadTransport === "native-only", "audio WAV export stays native-only");
    assert(exported.consumedPackets > 0, "audio WAV export drains packets");
    assert(exported.consumedBytes > 0, "audio WAV export writes audio data bytes");

    const fileStat = await stat(outputPath);
    const header = await readFile(outputPath);
    const wavHeader = parseWavHeader(header);
    assert(fileStat.size === exported.fileBytes, "audio WAV export fileBytes matches stat size");
    assert(wavHeader.dataBytes === exported.consumedBytes, "audio WAV data chunk matches consumed bytes");
    assert(wavHeader.fileBytes === fileStat.size, "audio WAV header size matches file size");

    const after = await request("status");
    assert(after.stats?.audioPayloadConsumeCount >= exported.consumedPackets, "audio WAV export updates consume count");
    assert(after.stats?.audioPayloadConsumedBytes >= exported.consumedBytes, "audio WAV export updates consumed bytes");
    assert(after.stats?.audioCaptureThread?.payloadQueue?.consumerStatus === "wav-export", "audio WAV export consumer status is visible");

    summary = {
      status: "passed",
      mode: started.captureSession?.mode,
      boundAudioEndpoints: started.captureSession?.boundAudioEndpoints,
      copiedPackets: before.stats?.audioPayloadCopyCount ?? 0,
      exportedPackets: exported.consumedPackets,
      exportedBytes: exported.consumedBytes,
      fileBytes: fileStat.size,
      path: outputPath,
      wavHeader,
      waveFormat: exported.waveFormat,
      queuedBytesAfter: after.stats?.audioPayloadQueueBytes ?? 0,
      consumerStatus: after.stats?.audioCaptureThread?.payloadQueue?.consumerStatus ?? null,
      exportedOverJson: exported.exportedOverJson,
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
  assert(stopped.captureSession?.state === "idle", "worker stops after audio WAV export");
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
