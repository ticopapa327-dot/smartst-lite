import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const durationSeconds = Number.parseInt(process.env.UST_USB4_DURATION_SECONDS || "10", 10);
const requestedFrameRate = Number.parseInt(process.env.UST_USB4_FRAME_RATE || "30", 10);
const minAcceptableFps = Number.parseInt(process.env.UST_USB4_MIN_ACCEPTABLE_FPS || "24", 10);
const probe = JSON.parse((await runNode(resolve(rootDir, "media-worker-poc/device-probe.mjs"))).stdout);
const videoDevices = probe.devices.video;
const requiredVideoChannels = 4;

const result = {
  generatedAt: new Date().toISOString(),
  status: "blocked",
  validationMode: "parallel-ffmpeg-directshow",
  requiredVideoChannels,
  detectedVideoChannels: videoDevices.length,
  durationSeconds,
  requestedFrameRate,
  minAcceptableFps,
  probeApi: probe.probeApi,
  finalNativeApi: probe.finalNativeApi,
  devices: videoDevices.map((device) => ({
    name: device.name,
    alternativeName: device.alternativeName,
  })),
  attempts: [],
  blockers: [],
  warnings: [],
};

if (videoDevices.length < requiredVideoChannels) {
  result.blockers.push({
    code: "insufficient-video-devices",
    message: `Detected ${videoDevices.length} video device(s), need ${requiredVideoChannels} USB capture channels.`,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

result.status = "running";
const startedAt = Date.now();
const duplicateNames = new Set(
  videoDevices
    .map((device) => device.name)
    .filter((name, index, names) => names.indexOf(name) !== index),
);
result.attempts = await Promise.all(
  videoDevices
    .slice(0, requiredVideoChannels)
    .map((device, index) => openVideoDevice(device, index, duplicateNames.has(device.name))),
);
result.elapsedMs = Date.now() - startedAt;

const failed = result.attempts.filter((attempt) => !attempt.opened);
const degraded = result.attempts.filter((attempt) => attempt.degraded);
result.status = failed.length > 0 ? "failed" : degraded.length > 0 ? "degraded" : "passed";
if (failed.length > 0) {
  result.blockers.push(
    ...failed.map((attempt) => ({
      code: "device-open-failed",
      message: `${attempt.deviceName} did not produce frames concurrently`,
    })),
  );
}
if (degraded.length > 0) {
  result.warnings.push(
    ...degraded.map((attempt) => ({
      code: "device-performance-degraded",
      message: `${attempt.deviceName} opened but did not meet ${minAcceptableFps}fps / realtime threshold`,
      deviceName: attempt.deviceName,
      mediaFps: attempt.mediaFps,
      wallFps: attempt.wallFps,
      realtimeRatio: attempt.realtimeRatio,
    })),
  );
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

async function openVideoDevice(device, index, forceAlternativeName) {
  const inputName = forceAlternativeName && device.alternativeName ? device.alternativeName : device.name;
  const startedMs = Date.now();
  const startedAt = new Date().toISOString();
  const probeResult = await runFfmpeg([
    "-hide_banner",
    "-f",
    "dshow",
    "-video_size",
    "640x480",
    "-framerate",
    String(requestedFrameRate),
    "-t",
    String(durationSeconds),
    "-i",
    `video=${inputName}`,
    "-f",
    "null",
    "-",
  ]);
  const completedMs = Date.now();
  const frames = parseLastFrameCount(probeResult.output);
  const elapsedMs = completedMs - startedMs;
  const mediaFps = Number((frames / durationSeconds).toFixed(2));
  const wallFps = Number((frames / (elapsedMs / 1000)).toFixed(2));
  const realtimeRatio = Number(((durationSeconds * 1000) / elapsedMs).toFixed(2));
  const opened = frames > 0;
  const degraded =
    opened &&
    (mediaFps < minAcceptableFps || wallFps < minAcceptableFps || realtimeRatio < 0.9);
  return {
    channelIndex: index + 1,
    deviceName: device.name,
    inputName,
    usedAlternativeName: inputName === device.alternativeName,
    startedAt,
    completedAt: new Date().toISOString(),
    opened,
    degraded,
    frames,
    mediaFps,
    wallFps,
    realtimeRatio,
    elapsedMs,
    exitCode: probeResult.exitCode,
    summary: summarizeFfmpegOutput(probeResult.output),
  };
}

function parseLastFrameCount(output) {
  const matches = [...output.matchAll(/frame=\s*(\d+)/g)];
  if (matches.length === 0) return 0;
  return Number.parseInt(matches[matches.length - 1][1], 10);
}

function summarizeFfmpegOutput(output) {
  return output
    .split(/\r?\n|\r/)
    .filter((line) => line.includes("Input #") || line.includes("Stream #") || line.includes("frame=") || line.includes("Error"))
    .map((line) => line.trim())
    .slice(-8);
}

function runNode(scriptPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (exitCode) => {
      if (exitCode !== 0) {
        rejectPromise(new Error(`node ${scriptPath} exited ${exitCode}: ${stderr}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function runFfmpeg(args) {
  return new Promise((resolvePromise) => {
    const child = spawn("ffmpeg", args, {
      windowsHide: true,
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => {
      resolvePromise({ exitCode: -1, output: error.message });
    });
    child.on("close", (exitCode) => {
      resolvePromise({ exitCode: exitCode ?? 0, output });
    });
  });
}
