import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = process.env.UST_RECORDING_POC_DIR
  ? resolve(process.env.UST_RECORDING_POC_DIR)
  : resolve(rootDir, "runtime/recordings-poc");
const recordingId = `rec-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
const recordingDir = join(outputRoot, recordingId);
const manifestPath = join(recordingDir, "manifest.json");
const events = [];

await mkdir(recordingDir, { recursive: true });

const manifest = {
  schemaVersion: "ust.recording-manifest.v0.1",
  recordingId,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  patientBinding: {
    status: "unbound",
    patientId: null,
    hisSource: null,
    boundAt: null,
  },
  source: {
    capturePath: "ffmpeg-directshow-preflight",
    finalNativeApi: {
      mediaFoundation: false,
      wasapi: false,
    },
  },
  channels: [],
  storage: {
    localBasePath: recordingDir,
    exports: [
      { type: "local", status: "available" },
      { type: "removable", status: "not-requested" },
      { type: "ftp", status: "not-configured" },
    ],
  },
  aiProcessing: {
    status: "not-requested",
    reservedInterfaces: [
      {
        name: "postRecordingAnalysis",
        input: "RecordingManifest + selected channel files",
        status: "reserved",
      },
    ],
  },
  events,
};

addEvent("recording", "created", { recordingId });

const probe = await runNode(resolve(rootDir, "media-worker-poc/device-probe.mjs"));
const probeResult = JSON.parse(probe.stdout);
manifest.source.probe = {
  generatedAt: probeResult.generatedAt,
  videoDeviceCount: probeResult.devices.video.length,
  audioDeviceCount: probeResult.devices.audio.length,
  ffmpegAvailable: probeResult.ffmpeg.available,
};

const videoDevice = probeResult.devices.video[0];
if (!probeResult.ffmpeg.available || !videoDevice) {
  manifest.channels.push({
    channelId: "field-camera",
    role: "field",
    sourceName: videoDevice?.name,
    status: "skipped",
    reason: probeResult.ffmpeg.available ? "no-video-device" : "ffmpeg-not-available",
    file: null,
  });
  addEvent("channel", "skipped", manifest.channels[0]);
} else {
  const capability = chooseRecordingCapability(probeResult.videoCapabilities?.capabilities ?? []);
  const outputFile = join(recordingDir, "field-camera.mkv");
  const channel = {
    channelId: "field-camera",
    role: "field",
    sourceName: videoDevice.name,
    status: "recording",
    trackName: "video:field-camera",
    requested: {
      width: capability.width,
      height: capability.height,
      frameRate: capability.frameRate,
      durationMs: 2000,
    },
    file: {
      relativePath: normalizeRelative(recordingDir, outputFile),
      container: "matroska",
      codec: "copy",
      sizeBytes: 0,
      sha256: null,
    },
  };
  manifest.channels.push(channel);
  addEvent("channel", "recording-started", {
    channelId: channel.channelId,
    sourceName: channel.sourceName,
  });

  const recordResult = await runFfmpeg([
    "-y",
    "-hide_banner",
    "-f",
    "dshow",
    "-video_size",
    `${capability.width}x${capability.height}`,
    "-framerate",
    String(capability.frameRate),
    "-t",
    "2",
    "-i",
    `video=${videoDevice.name}`,
    "-an",
    "-c:v",
    "copy",
    outputFile,
  ]);

  const fileStat = await safeStat(outputFile);
  if (fileStat && fileStat.size > 0) {
    channel.status = "completed";
    channel.file.sizeBytes = fileStat.size;
    channel.file.sha256 = await sha256File(outputFile);
    channel.frames = parseLastFrameCount(recordResult.output);
    channel.ffmpegExitCode = recordResult.exitCode;
    addEvent("channel", "recording-completed", {
      channelId: channel.channelId,
      sizeBytes: fileStat.size,
      frames: channel.frames,
    });
  } else {
    channel.status = "failed";
    channel.error = {
      code: "recording-file-missing",
      message: "ffmpeg finished but output file was not created",
      ffmpegExitCode: recordResult.exitCode,
      summary: summarizeFfmpegOutput(recordResult.output),
    };
    addEvent("error", "recording-file-missing", channel.error);
  }
}

manifest.updatedAt = new Date().toISOString();
addEvent("recording", "manifest-written", {
  manifestPath,
});
await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

process.stdout.write(
  `${JSON.stringify(
    {
      manifestPath,
      recordingDir,
      manifest,
    },
    null,
    2,
  )}\n`,
);

function addEvent(category, name, payload) {
  events.push({
    category,
    name,
    payload,
    time: new Date().toISOString(),
  });
}

function chooseRecordingCapability(capabilities) {
  const exact = capabilities.find(
    (capability) =>
      capability.width === 640 &&
      capability.height === 480 &&
      Math.round(capability.frameRate) === 30,
  );
  return exact || capabilities[0] || { width: 640, height: 480, frameRate: 30 };
}

function normalizeRelative(from, to) {
  return relative(from, to).replace(/\\/g, "/");
}

async function safeStat(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

function sha256File(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectPromise);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

function parseLastFrameCount(output) {
  const matches = [...output.matchAll(/frame=\s*(\d+)/g)];
  if (matches.length === 0) return 0;
  return Number.parseInt(matches[matches.length - 1][1], 10);
}

function summarizeFfmpegOutput(output) {
  return output
    .split(/\r?\n/)
    .filter((line) => line.includes("Input #0") || line.includes("Stream #") || line.includes("frame="))
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
      resolvePromise({
        exitCode: -1,
        output: error.message,
      });
    });
    child.on("close", (exitCode) => {
      resolvePromise({
        exitCode: exitCode ?? 0,
        output,
      });
    });
  });
}
