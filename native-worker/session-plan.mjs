import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(rootDir, "native-worker/Cargo.toml");
const outputPath = resolve(
  rootDir,
  process.env.SMARTST_NATIVE_SESSION_PLAN_PATH || "native-worker/.tmp/session-plan-smoke.json",
);

const videoIndex = readIntegerEnv("SMARTST_NATIVE_VIDEO_INDEX", 0);
const maxMediaTypes = readIntegerEnv("SMARTST_NATIVE_VIDEO_FORMAT_MAX_TYPES", 128);
const holdMs = readIntegerEnv("SMARTST_NATIVE_SESSION_HOLD_MS", 500);
const preferredSubtype = process.env.SMARTST_NATIVE_VIDEO_PREFERRED_SUBTYPE || "NV12";

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
  const error = new Error(`native worker exited before session plan smoke completed. exit=${exitCode}. stderr=${stderr}`);
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

  const capabilities = await request("probeVideoCapabilities", {
    index: videoIndex,
    maxMediaTypes,
  });
  const deviceCapabilities = capabilities.devices?.[0];
  const selectedVideo = deviceCapabilities?.device;
  const capability = selectCapability(deviceCapabilities?.capabilities ?? []);
  if (!selectedVideo || !capability) {
    completed = true;
    console.log(
      JSON.stringify(
        {
          status: "skipped",
          reason: "no-video-session-plan-source",
          deviceCount: capabilities.deviceCount ?? 0,
        },
        null,
        2,
      ),
    );
    await request("shutdown");
  } else {
    const channelId = "field-camera";
    const selector = {
      index: selectedVideo.index,
      deviceId: selectedVideo.deviceId,
    };
    const preference = {
      subtypeFourCc: capability.subtypeFourCc || capability.subtype,
      width: capability.width,
      height: capability.height,
      frameRate: capability.frameRate,
      maxMediaTypes,
    };
    const started = await request("start", {
      channels: [channelId],
      videoChannelBindings: {
        [channelId]: selector,
      },
      videoFormatPreference: preference,
      startVideoThread: true,
      startAudioThread: false,
      videoFrameQueueCapacity: 3,
    });

    await new Promise((resolvePromise) => setTimeout(resolvePromise, holdMs));
    const status = await request("status");
    const channel = started.channels?.[0];
    const thread = getVideoThreads(status.stats)[0];
    assert(channel?.deviceBinding?.mode === "explicit", "session plan uses explicit device binding");
    assert(channel?.mediaTypeSelection?.mode === "preference", "session plan uses format preference");
    assert(channel?.device?.deviceId === selectedVideo.deviceId, "session plan binds expected device");
    assert(channel?.mediaType?.mediaTypeIndex === channel?.mediaTypeSelection?.selectedIndex, "session plan media type matches selected index");
    assert(thread?.frameQueue?.payloadQueue?.copyCount > 0, "session plan capture thread copies payload frames");

    const plan = {
      schemaVersion: "smartst.native-session-plan.v0.1",
      generatedAt: new Date().toISOString(),
      source: {
        kind: "native-worker-session-plan-smoke",
        rootDir,
      },
      captureSession: {
        mode: started.captureSession?.mode,
        realMediaSession: started.captureSession?.realMediaSession,
        boundVideoChannels: started.captureSession?.boundVideoChannels,
        continuousVideoThreads: started.captureSession?.continuousVideoThreads,
      },
      channels: [
        {
          channelId,
          deviceBinding: channel.deviceBinding,
          mediaTypeSelection: channel.mediaTypeSelection,
          device: channel.device,
          mediaType: channel.mediaType,
          copiedFrames: thread.frameQueue.payloadQueue.copyCount,
        },
      ],
    };

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    const stopped = await request("stop");
    assert(stopped.captureSession?.state === "idle", "worker stops after session plan smoke");
    completed = true;
    console.log(
      JSON.stringify(
        {
          status: "passed",
          outputPath,
          schemaVersion: plan.schemaVersion,
          channelCount: plan.channels.length,
          channelId,
          selectedDeviceId: channel.deviceBinding.selectedDeviceId,
          selectedMediaTypeIndex: channel.mediaTypeSelection.selectedIndex,
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

function selectCapability(capabilities) {
  const valid = capabilities.filter((capability) => capability.width > 0 && capability.height > 0);
  return (
    valid.find((capability) => capability.subtypeFourCc === preferredSubtype && capability.frameRate > 0) ??
    valid.find((capability) => capability.subtypeFourCc === preferredSubtype) ??
    valid.find((capability) => capability.frameRate > 0) ??
    valid[0]
  );
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
