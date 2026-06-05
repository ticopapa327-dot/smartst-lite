import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";

export async function inspectArtifact(rootDir, filePath, parser) {
  const [fileStat, bytes] = await Promise.all([stat(filePath), readFile(filePath)]);
  assert(fileStat.size === bytes.length, `artifact stat size matches read size for ${filePath}`);
  const parsed = parser(bytes);
  assert(parsed.fileBytes === fileStat.size, `artifact parser size matches stat size for ${filePath}`);
  return {
    path: filePath,
    relativePath: toPortablePath(relative(rootDir, filePath)),
    bytes: fileStat.size,
    modifiedAt: fileStat.mtime.toISOString(),
    modifiedAtMs: fileStat.mtimeMs,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    parsed,
  };
}

export function parsePgm(bytes) {
  assert(bytes.toString("ascii", 0, 3) === "P5\n", "video PGM output has P5 header");
  const secondNewline = bytes.indexOf(0x0a, 3);
  assert(secondNewline > 3, "video PGM output has size line");
  const thirdNewline = bytes.indexOf(0x0a, secondNewline + 1);
  assert(thirdNewline > secondNewline, "video PGM output has max value line");
  const [widthText, heightText] = bytes.toString("ascii", 3, secondNewline).split(" ");
  const width = Number.parseInt(widthText, 10);
  const height = Number.parseInt(heightText, 10);
  const maxValue = Number.parseInt(bytes.toString("ascii", secondNewline + 1, thirdNewline), 10);
  assert(Number.isInteger(width) && width > 0, "video PGM width is valid");
  assert(Number.isInteger(height) && height > 0, "video PGM height is valid");
  assert(maxValue === 255, "video PGM max value is 255");
  const pixelOffset = thirdNewline + 1;
  const pixelBytes = width * height;
  assert(bytes.length === pixelOffset + pixelBytes, "video PGM pixel data size matches dimensions");
  let min = 255;
  let max = 0;
  let sum = 0;
  for (let index = pixelOffset; index < bytes.length; index += 1) {
    const value = bytes[index];
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }
  return {
    width,
    height,
    maxValue,
    pixelBytes,
    headerBytes: pixelOffset,
    fileBytes: bytes.length,
    luma: {
      min,
      max,
      average: sum / pixelBytes,
    },
  };
}

export function parsePpm(bytes) {
  assert(bytes.toString("ascii", 0, 3) === "P6\n", "video PPM output has P6 header");
  const secondNewline = bytes.indexOf(0x0a, 3);
  assert(secondNewline > 3, "video PPM output has size line");
  const thirdNewline = bytes.indexOf(0x0a, secondNewline + 1);
  assert(thirdNewline > secondNewline, "video PPM output has max value line");
  const [widthText, heightText] = bytes.toString("ascii", 3, secondNewline).split(" ");
  const width = Number.parseInt(widthText, 10);
  const height = Number.parseInt(heightText, 10);
  const maxValue = Number.parseInt(bytes.toString("ascii", secondNewline + 1, thirdNewline), 10);
  assert(Number.isInteger(width) && width > 0, "video PPM width is valid");
  assert(Number.isInteger(height) && height > 0, "video PPM height is valid");
  assert(maxValue === 255, "video PPM max value is 255");
  const pixelOffset = thirdNewline + 1;
  const pixelBytes = width * height * 3;
  assert(bytes.length === pixelOffset + pixelBytes, "video PPM pixel data size matches dimensions");
  const rgb = [
    { min: 255, max: 0, sum: 0 },
    { min: 255, max: 0, sum: 0 },
    { min: 255, max: 0, sum: 0 },
  ];
  for (let index = pixelOffset; index < bytes.length; index += 3) {
    for (let channel = 0; channel < 3; channel += 1) {
      const value = bytes[index + channel];
      if (value < rgb[channel].min) rgb[channel].min = value;
      if (value > rgb[channel].max) rgb[channel].max = value;
      rgb[channel].sum += value;
    }
  }
  const pixels = width * height;
  return {
    width,
    height,
    maxValue,
    pixelBytes,
    headerBytes: pixelOffset,
    fileBytes: bytes.length,
    rgb: {
      r: summarizeChannel(rgb[0], pixels),
      g: summarizeChannel(rgb[1], pixels),
      b: summarizeChannel(rgb[2], pixels),
    },
  };
}

export function parseWavHeader(bytes) {
  assert(bytes.length >= 44, "audio WAV output is at least 44 bytes");
  assert(bytes.toString("ascii", 0, 4) === "RIFF", "audio WAV output has RIFF header");
  assert(bytes.toString("ascii", 8, 12) === "WAVE", "audio WAV output has WAVE header");
  assert(bytes.toString("ascii", 12, 16) === "fmt ", "audio WAV output has fmt chunk");
  assert(bytes.toString("ascii", 36, 40) === "data", "audio WAV output has data chunk");
  const dataBytes = bytes.readUInt32LE(40);
  const riffBytes = bytes.readUInt32LE(4);
  return {
    audioFormat: bytes.readUInt16LE(20),
    channels: bytes.readUInt16LE(22),
    samplesPerSec: bytes.readUInt32LE(24),
    avgBytesPerSec: bytes.readUInt32LE(28),
    blockAlign: bytes.readUInt16LE(32),
    bitsPerSample: bytes.readUInt16LE(34),
    dataBytes,
    riffBytes,
    fileBytes: dataBytes + 44,
  };
}

export function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function summarizeChannel(channel, pixels) {
  return {
    min: channel.min,
    max: channel.max,
    average: channel.sum / pixels,
  };
}

function toPortablePath(path) {
  return path.split("\\").join("/");
}
