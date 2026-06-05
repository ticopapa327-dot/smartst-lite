import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = JSON.parse((await runNode(resolve(rootDir, "media-worker-poc/native-readiness.mjs"))).stdout);

assert(["ready", "blocked"].includes(result.status), "status is explicit");
assert(result.checks.platform, "platform check exists");
assert(result.checks.ffmpeg, "ffmpeg check exists");
assert(result.recommendation.selectedControlPlane === "json-lines-stdin-stdout", "control plane is stable");
assert(
  result.recommendation.preferredProductionPath.some((item) => item.includes("Media Foundation")),
  "Media Foundation is named as production video path",
);
assert(
  result.recommendation.preferredProductionPath.some((item) => item.includes("WASAPI")),
  "WASAPI is named as production audio path",
);

console.log("media-worker native readiness smoke passed");

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
