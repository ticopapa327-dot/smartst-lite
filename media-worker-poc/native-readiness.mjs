import { spawn } from "node:child_process";

const checks = {
  platform: {
    name: "Windows platform",
    ok: process.platform === "win32",
    value: process.platform,
  },
  node: {
    name: "Node.js",
    ok: true,
    value: process.version,
  },
  rustc: await versionCheck("rustc", ["--version"]),
  cargo: await versionCheck("cargo", ["--version"]),
  ffmpeg: await versionCheck("ffmpeg", ["-version"]),
  ffprobe: await versionCheck("ffprobe", ["-version"]),
};

const blockers = Object.entries(checks)
  .filter(([, check]) => !check.ok)
  .map(([key, check]) => ({ key, name: check.name, value: check.value }));

const recommendation = {
  selectedControlPlane: "json-lines-stdin-stdout",
  preferredProductionPath: [
    "Rust native worker process keeps the existing JSON Lines control contract.",
    "Media Foundation enumerates and opens UVC / USB capture devices.",
    "WASAPI enumerates and captures audio devices.",
    "Encoding, recording, and LiveKit publishing remain inside the worker, not the React UI.",
    "FFmpeg/DirectShow remains a validation fallback, not the production capture API.",
  ],
  nextImplementationStep: blockers.length === 0
    ? "Create a Rust worker crate and port listDevices/start/stop/status control handlers."
    : "Install missing native prerequisites before creating the Rust worker crate.",
};

const result = {
  generatedAt: new Date().toISOString(),
  status: blockers.length === 0 ? "ready" : "blocked",
  checks,
  blockers,
  recommendation,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function versionCheck(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
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
      resolve({
        name: command,
        ok: false,
        value: error.message,
      });
    });
    child.on("close", (exitCode) => {
      resolve({
        name: command,
        ok: exitCode === 0,
        value: firstLine(output),
      });
    });
  });
}

function firstLine(output) {
  return output.split(/\r?\n/).find((line) => line.trim()) || "";
}
