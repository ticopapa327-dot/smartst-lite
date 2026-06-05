import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const probePath = resolve(rootDir, "media-worker-poc/device-probe.mjs");
const probe = await runNode(probePath);
const result = JSON.parse(probe.stdout);

assert(result.probeApi === "ffmpeg-directshow-preflight", "probe API is explicit");
assert(result.finalNativeApi.mediaFoundation === false, "Media Foundation is not claimed");
assert(result.finalNativeApi.wasapi === false, "WASAPI is not claimed");
assert(Array.isArray(result.devices.video), "video devices array exists");
assert(Array.isArray(result.devices.audio), "audio devices array exists");
assert(Array.isArray(result.warnings), "warnings are present");

if (result.ffmpeg.available && result.devices.video.length > 0) {
  assert(result.videoCapabilities.deviceName, "video capability device name exists");
  assert(Array.isArray(result.videoCapabilities.capabilities), "video capabilities array exists");
  assert(result.openAttempts.video.attempted === true, "video open is attempted");
  if (result.openAttempts.video.opened) {
    assert(result.openAttempts.video.frames > 0, "opened video produces frames");
  }
}

if (result.ffmpeg.available && result.devices.audio.length > 0) {
  assert(result.openAttempts.audio.attempted === true, "audio open is attempted");
}

console.log("media-worker device probe smoke passed");

function runNode(scriptPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"],
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
        rejectPromise(new Error(`probe exited ${exitCode}: ${stderr}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
