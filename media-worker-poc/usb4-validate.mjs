import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const durationSeconds = Number.parseInt(process.env.SMARTST_USB4_DURATION_SECONDS || "10", 10);
const probe = JSON.parse((await runNode(resolve(rootDir, "media-worker-poc/device-probe.mjs"))).stdout);
const videoDevices = probe.devices.video;
const requiredVideoChannels = 4;

const result = {
  generatedAt: new Date().toISOString(),
  status: "blocked",
  requiredVideoChannels,
  detectedVideoChannels: videoDevices.length,
  durationSeconds,
  probeApi: probe.probeApi,
  finalNativeApi: probe.finalNativeApi,
  devices: videoDevices.map((device) => ({
    name: device.name,
    alternativeName: device.alternativeName,
  })),
  attempts: [],
  blockers: [],
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
for (const device of videoDevices.slice(0, requiredVideoChannels)) {
  const attempt = await openVideoDevice(device.name);
  result.attempts.push(attempt);
}

const failed = result.attempts.filter((attempt) => !attempt.opened);
result.status = failed.length === 0 ? "passed" : "failed";
if (failed.length > 0) {
  result.blockers.push(
    ...failed.map((attempt) => ({
      code: "device-open-failed",
      message: `${attempt.deviceName} did not produce frames`,
    })),
  );
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

async function openVideoDevice(deviceName) {
  const probeResult = await runFfmpeg([
    "-hide_banner",
    "-f",
    "dshow",
    "-video_size",
    "640x480",
    "-framerate",
    "30",
    "-t",
    String(durationSeconds),
    "-i",
    `video=${deviceName}`,
    "-f",
    "null",
    "-",
  ]);
  const frames = parseLastFrameCount(probeResult.output);
  return {
    deviceName,
    opened: frames > 0,
    frames,
    exitCode: probeResult.exitCode,
  };
}

function parseLastFrameCount(output) {
  const matches = [...output.matchAll(/frame=\s*(\d+)/g)];
  if (matches.length === 0) return 0;
  return Number.parseInt(matches[matches.length - 1][1], 10);
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
