import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = JSON.parse((await runNode(resolve(rootDir, "media-worker-poc/usb4-validate.mjs"))).stdout);

assert(["blocked", "passed", "failed"].includes(result.status), "status is explicit");
assert(result.requiredVideoChannels === 4, "requires four channels");
assert(typeof result.detectedVideoChannels === "number", "detected channel count exists");
assert(result.probeApi === "ffmpeg-directshow-preflight", "probe API is explicit");
assert(result.finalNativeApi.mediaFoundation === false, "does not claim Media Foundation");

if (result.detectedVideoChannels < 4) {
  assert(result.status === "blocked", "insufficient hardware blocks validation");
  assert(
    result.blockers.some((blocker) => blocker.code === "insufficient-video-devices"),
    "insufficient hardware blocker is explicit",
  );
}

console.log("media-worker usb4 validate smoke passed");

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

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
