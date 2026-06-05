import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  inspectArtifact,
  parsePgm,
  parsePpm,
  parseWavHeader,
} from "./export-artifact-utils.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(
  rootDir,
  process.env.SMARTST_NATIVE_EXPORT_MANIFEST_PATH || "native-worker/.tmp/export-artifact-manifest.json",
);
const maxArtifactAgeMs = readIntegerEnv("SMARTST_NATIVE_EXPORT_MANIFEST_MAX_AGE_MS", 300000);
const inspectedAtMs = Date.now();

const artifactSpecs = [
  {
    id: "video-pgm",
    mediaKind: "video",
    fileFormat: "pgm",
    defaultPath: "native-worker/.tmp/video-payload-export.pgm",
    envPath: "SMARTST_NATIVE_VIDEO_PGM_EXPORT_PATH",
    parser: parsePgm,
    summarize: (parsed) => ({
      width: parsed.width,
      height: parsed.height,
      pixelBytes: parsed.pixelBytes,
      luma: parsed.luma,
    }),
  },
  {
    id: "video-ppm",
    mediaKind: "video",
    fileFormat: "ppm",
    defaultPath: "native-worker/.tmp/video-payload-export.ppm",
    envPath: "SMARTST_NATIVE_VIDEO_PPM_EXPORT_PATH",
    parser: parsePpm,
    summarize: (parsed) => ({
      width: parsed.width,
      height: parsed.height,
      pixelBytes: parsed.pixelBytes,
      rgb: parsed.rgb,
    }),
  },
  {
    id: "audio-wav",
    mediaKind: "audio",
    fileFormat: "wav",
    defaultPath: "native-worker/.tmp/audio-payload-export.wav",
    envPath: "SMARTST_NATIVE_AUDIO_WAV_EXPORT_PATH",
    parser: parseWavHeader,
    summarize: (parsed) => ({
      audioFormat: parsed.audioFormat,
      channels: parsed.channels,
      samplesPerSec: parsed.samplesPerSec,
      bitsPerSample: parsed.bitsPerSample,
      dataBytes: parsed.dataBytes,
    }),
  },
];

const artifacts = [];
for (const spec of artifactSpecs) {
  const filePath = resolve(rootDir, process.env[spec.envPath] || spec.defaultPath);
  const artifact = await inspectArtifact(rootDir, filePath, spec.parser);
  const ageMs = inspectedAtMs - artifact.modifiedAtMs;
  if (maxArtifactAgeMs > 0) {
    assert(ageMs >= 0, `${spec.id} artifact timestamp is not in the future`);
    assert(ageMs <= maxArtifactAgeMs, `${spec.id} artifact is fresh enough for export manifest smoke`);
  }
  artifacts.push({
    id: spec.id,
    mediaKind: spec.mediaKind,
    fileFormat: spec.fileFormat,
    path: artifact.path,
    relativePath: artifact.relativePath,
    bytes: artifact.bytes,
    modifiedAt: artifact.modifiedAt,
    ageMs,
    sha256: artifact.sha256,
    metadata: spec.summarize(artifact.parsed),
  });
}

assert(artifacts.length === artifactSpecs.length, "all native export artifacts are inspected");
assert(artifacts.every((artifact) => artifact.bytes > 0), "all native export artifacts have bytes");
assert(
  new Set(artifacts.map((artifact) => artifact.sha256)).size === artifacts.length,
  "native export artifacts have distinct checksums",
);

const manifest = {
  schemaVersion: "smartst.native-export-artifacts.v0.1",
  generatedAt: new Date().toISOString(),
  source: {
    kind: "native-worker-export-smoke",
    rootDir,
    maxArtifactAgeMs,
  },
  artifacts,
};

await mkdir(dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      status: "passed",
      manifestPath,
      artifactCount: artifacts.length,
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        mediaKind: artifact.mediaKind,
        fileFormat: artifact.fileFormat,
        bytes: artifact.bytes,
        ageMs: artifact.ageMs,
        sha256: artifact.sha256,
        metadata: artifact.metadata,
      })),
    },
    null,
    2,
  ),
);

function readIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}
