import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = JSON.parse((await runNode(resolve(rootDir, "media-worker-poc/recording-poc.mjs"))).stdout);
const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));

assert(manifest.schemaVersion === "ust.recording-manifest.v0.1", "schema version is stable");
assert(manifest.patientBinding.status === "unbound", "patient binding is absent in PoC");
assert(manifest.source.finalNativeApi.mediaFoundation === false, "Media Foundation is not claimed");
assert(manifest.source.finalNativeApi.wasapi === false, "WASAPI is not claimed");
assert(Array.isArray(manifest.channels) && manifest.channels.length >= 1, "channel entries exist");
assert(Array.isArray(manifest.events) && manifest.events.length >= 2, "events are recorded");
assert(manifest.aiProcessing.reservedInterfaces.length >= 1, "AI interface is reserved");
assert(
  manifest.storage.exports.some((item) => item.type === "ftp" && item.status === "not-configured"),
  "FTP export status is explicit",
);

const channel = manifest.channels[0];
if (channel.status === "completed") {
  const filePath = join(result.recordingDir, channel.file.relativePath);
  const fileStat = await stat(filePath);
  assert(fileStat.size === channel.file.sizeBytes, "manifest size matches file size");
  assert(channel.file.sha256 && channel.file.sha256.length === 64, "sha256 is recorded");
  assert(channel.frames > 0, "frames are recorded");
} else {
  assert(["failed", "skipped"].includes(channel.status), "non-completed state is explicit");
}

console.log("recording-poc smoke passed");

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
