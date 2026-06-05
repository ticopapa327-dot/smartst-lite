import { spawn } from "node:child_process";

const generatedAt = new Date().toISOString();
const warnings = [
  "This probe uses ffmpeg DirectShow preflight, not final Media Foundation/WASAPI capture.",
];

const ffmpegVersion = await runFfmpeg(["-version"]);
const ffmpegAvailable = ffmpegVersion.exitCode === 0;

let devices = { video: [], audio: [] };
let videoCapabilities = undefined;
let openAttempts = {
  video: undefined,
  audio: undefined,
};

if (ffmpegAvailable) {
  const deviceList = await runFfmpeg([
    "-hide_banner",
    "-list_devices",
    "true",
    "-f",
    "dshow",
    "-i",
    "dummy",
  ]);
  devices = parseDevices(deviceList.output);

  if (devices.video[0]) {
    const options = await runFfmpeg([
      "-hide_banner",
      "-list_options",
      "true",
      "-f",
      "dshow",
      "-i",
      `video=${devices.video[0].name}`,
    ]);
    videoCapabilities = {
      deviceName: devices.video[0].name,
      capabilities: parseCapabilities(options.output),
      rawExitCode: options.exitCode,
    };
    openAttempts.video = await openVideoDevice(devices.video[0].name, videoCapabilities.capabilities);
  }

  if (devices.audio[0]) {
    openAttempts.audio = await openAudioDevice(devices.audio[0].name);
  }
} else {
  warnings.push("ffmpeg was not found on PATH; device probe could not enumerate DirectShow devices.");
}

const result = {
  generatedAt,
  platform: process.platform,
  probeApi: "ffmpeg-directshow-preflight",
  finalNativeApi: {
    mediaFoundation: false,
    wasapi: false,
  },
  ffmpeg: {
    available: ffmpegAvailable,
    versionLine: firstNonEmptyLine(ffmpegVersion.output),
  },
  devices,
  videoCapabilities,
  openAttempts,
  warnings,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

async function openVideoDevice(deviceName, capabilities) {
  const preferred = choosePreferredVideoCapability(capabilities);
  const args = [
    "-hide_banner",
    "-f",
    "dshow",
    "-video_size",
    `${preferred.width}x${preferred.height}`,
    "-framerate",
    String(preferred.frameRate),
    "-t",
    "2",
    "-i",
    `video=${deviceName}`,
    "-f",
    "null",
    "-",
  ];
  const probe = await runFfmpeg(args);
  const frames = parseLastFrameCount(probe.output);
  return {
    deviceName,
    attempted: true,
    opened: frames > 0 || probe.output.includes("Input #0"),
    width: preferred.width,
    height: preferred.height,
    frameRate: preferred.frameRate,
    frames,
    exitCode: probe.exitCode,
    summary: summarizeFfmpegOutput(probe.output),
  };
}

async function openAudioDevice(deviceName) {
  const probe = await runFfmpeg([
    "-hide_banner",
    "-f",
    "dshow",
    "-t",
    "1",
    "-i",
    `audio=${deviceName}`,
    "-f",
    "null",
    "-",
  ]);
  return {
    deviceName,
    attempted: true,
    opened: probe.output.includes("Input #0") || probe.output.includes("Stream #0"),
    exitCode: probe.exitCode,
    summary: summarizeFfmpegOutput(probe.output),
  };
}

function choosePreferredVideoCapability(capabilities = []) {
  const exact = capabilities.find(
    (capability) =>
      capability.width === 640 &&
      capability.height === 480 &&
      Math.round(capability.frameRate) === 30,
  );
  const first = capabilities[0];
  return exact || first || { width: 640, height: 480, frameRate: 30 };
}

function parseDevices(output) {
  const parsed = { video: [], audio: [] };
  let lastDevice = undefined;

  for (const line of output.split(/\r?\n/)) {
    const deviceMatch = line.match(/"(.+)" \((video|audio)\)/);
    if (deviceMatch) {
      lastDevice = {
        name: deviceMatch[1],
        type: deviceMatch[2],
        alternativeName: undefined,
      };
      parsed[deviceMatch[2]].push(lastDevice);
      continue;
    }

    const altMatch = line.match(/Alternative name "(.+)"/);
    if (altMatch && lastDevice) {
      lastDevice.alternativeName = altMatch[1];
    }
  }

  return parsed;
}

function parseCapabilities(output) {
  const capabilities = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(
      /(vcodec=([^\s]+)|pixel_format=([^\s]+)).*min s=(\d+)x(\d+) fps=([\d.]+).*max s=(\d+)x(\d+) fps=([\d.]+)/,
    );
    if (!match) continue;
    capabilities.push({
      codec: match[2],
      pixelFormat: match[3],
      width: Number.parseInt(match[4], 10),
      height: Number.parseInt(match[5], 10),
      frameRate: Number.parseFloat(match[6]),
      maxWidth: Number.parseInt(match[7], 10),
      maxHeight: Number.parseInt(match[8], 10),
      maxFrameRate: Number.parseFloat(match[9]),
    });
  }
  return capabilities;
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

function firstNonEmptyLine(output) {
  return output.split(/\r?\n/).find((line) => line.trim()) || "";
}

function runFfmpeg(args) {
  return new Promise((resolve) => {
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
      resolve({
        exitCode: -1,
        output: error.message,
      });
    });
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 0,
        output,
      });
    });
  });
}
