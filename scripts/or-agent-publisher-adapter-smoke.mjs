import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  VideoBufferType,
  VideoFrame,
  VideoSource,
  dispose,
} from "@livekit/rtc-node";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RoomServiceClient } from "livekit-server-sdk";

const repoRoot = resolve(import.meta.dirname, "..");
const runtimeDir = join(repoRoot, "runtime", "or-connectivity");
const adapterRuntimeDir = join(runtimeDir, "or-agent-publisher");
const processStateFile = join(runtimeDir, "processes.json");
const keyFile = join(runtimeDir, "livekit.keys");
const startedAt = new Date();

const roomsToDisconnect = [];
const resourcesToClose = [];
let nativeWorker;
let roomClient;
let roomId;

const config = await readConfig();

async function main() {
try {
  await mkdir(adapterRuntimeDir, { recursive: true });
  assert(config.apiKey && config.apiSecret, "LIVEKIT_API_KEY/LIVEKIT_API_SECRET are required");

  roomClient = new RoomServiceClient(
    livekitApiHostFromUrl(config.livekitUrl),
    config.apiKey,
    config.apiSecret,
    { requestTimeout: config.timeoutMs },
  );

  const orEndpoint = await postJson(`${config.businessUrl}/api/endpoints/register`, {
    id: `or-agent-${timestampForPath(startedAt)}`,
    clientType: "or-windows",
    displayName: "OR Agent Publisher Smoke",
    tags: ["or-agent", "publisher-smoke"],
  });

  const teachingEndpoint = await postJson(`${config.businessUrl}/api/endpoints/register`, {
    id: `desktop-teaching-${timestampForPath(startedAt)}`,
    clientType: "teaching-windows",
    displayName: "Desktop Client Subscriber Smoke",
    tags: ["desktop-client", "teaching-smoke"],
  });

  const call = await postJson(`${config.businessUrl}/api/calls`, {
    callerEndpointId: teachingEndpoint.endpoint.id,
    targetEndpointId: orEndpoint.endpoint.id,
    requestedMode: "interactive",
  }, 201);

  const accepted = await postJson(`${config.businessUrl}/api/calls/${call.call.id}/accept`, {
    mode: "interactive",
    roomCode: `ST-ORPUB-${timestampForPath(startedAt).slice(0, 8)}-${timestampForPath(startedAt).slice(8)}`,
    defaultChannelId: "field-camera",
    channels: [
      {
        id: "field-camera",
        displayName: "术野摄像机",
        enabled: true,
        health: "healthy",
        localPrimary: true,
        remoteDefault: true,
        priority: 10,
        trackName: "video:field-camera",
      },
    ],
    limits: {
      maxInteractiveParticipants: 4,
      maxTabletClients: 2,
      maxWebObservers: config.observerCount,
    },
    hostIdentity: "or-agent-native-publisher",
  });

  roomId = accepted.room.roomId;
  await roomClient.createRoom({
    name: roomId,
    emptyTimeout: 600,
    departureTimeout: 30,
    maxParticipants: 16,
    metadata: JSON.stringify({
      purpose: "smartst-or-agent-publisher-adapter-smoke",
      roomCode: accepted.room.roomCode,
      defaultChannelId: accepted.room.mediaPolicy.defaultChannelId,
      createdAt: startedAt.toISOString(),
    }),
  });

  const teachingToken = await postJson(`${config.businessUrl}/api/rooms/${roomId}/tokens`, {
    clientType: "teaching-windows",
    identity: "desktop-client-teaching-subscriber",
    mode: "interactive",
  });

  const observerTokens = [];
  for (let index = 0; index < config.observerCount; index += 1) {
    const identity = `phone-orpub-observer-${String(index + 1).padStart(2, "0")}`;
    const token = await postJson(`${config.businessUrl}/api/observer/token`, {
      roomCode: accepted.room.roomCode,
      identity,
    });
    observerTokens.push({ ...token, requestedIdentity: identity });
  }

  assert(accepted.hostToken.grants.canPublish === true, "accepted OR host token cannot publish");
  assert(teachingToken.grants.canPublish === true, "teaching interactive token cannot publish");
  assert(
    teachingToken.metadata.defaultTrackName === "video:field-camera",
    "teaching token default track is not field-camera",
  );
  for (const token of observerTokens) {
    assert(token.grants.canPublish === false, "phone observer can publish");
    assert(token.grants.canPublishData === false, "phone observer can publish data");
  }

  nativeWorker = await NativeWorkerBridge.launch(config.nativeWorker);
  const nativeStarted = await nativeWorker.request("start", {
    channels: ["field-camera"],
    videoMediaTypeIndex: config.videoMediaTypeIndex,
    videoFrameQueueCapacity: config.videoFrameQueueCapacity,
    audioIndex: config.audioIndex,
    audioPayloadQueueCapacity: config.audioPayloadQueueCapacity,
    startVideoThread: true,
    startAudioThread: true,
  });
  await delay(config.initialNativeHoldMs);

  assert(
    (nativeStarted.captureSession?.boundVideoChannels ?? 0) > 0,
    "Native Worker did not bind a video channel",
  );
  assert(
    (nativeStarted.captureSession?.boundAudioEndpoints ?? 0) > 0,
    "Native Worker did not bind an audio endpoint",
  );

  const teachingRoom = await connectRoom(config.livekitUrl, teachingToken.token, "teaching-desktop");
  const teachingTracks = trackCollector(teachingRoom);
  const observerRooms = [];
  const observerTrackCollectors = [];
  for (const token of observerTokens) {
    const observerRoom = await connectRoom(config.livekitUrl, token.token, token.requestedIdentity);
    observerRooms.push(observerRoom);
    observerTrackCollectors.push(trackCollector(observerRoom));
  }

  const orRoom = await connectRoom(config.livekitUrl, accepted.hostToken.token, "or-agent");
  const publisher = await publishNativeWorkerMedia(orRoom, nativeWorker, config);

  await waitFor(
    () =>
      teachingTracks.videoTrackNames.includes("video:field-camera") &&
      teachingTracks.audioTrackNames.includes("audio:or-room"),
    config.timeoutMs,
    "Desktop teaching subscriber did not receive default OR audio/video tracks",
  );

  for (let index = 0; index < observerTrackCollectors.length; index += 1) {
    const collector = observerTrackCollectors[index];
    await waitFor(
      () =>
        collector.videoTrackNames.includes("video:field-camera") &&
        collector.audioTrackNames.includes("audio:or-room"),
      config.timeoutMs,
      `Phone observer ${index + 1} did not receive default OR audio/video tracks`,
    );
  }

  await publisher.finished;
  await delay(500);

  const participants = await roomClient.listParticipants(roomId);
  const orParticipant = participants.find((participant) => participant.identity === "or-agent-native-publisher");
  assert(orParticipant, "OR native publisher participant is missing from LiveKit");
  const orTrackNames = (orParticipant.tracks || []).map((track) => track.name).sort();
  assert(orTrackNames.includes("video:field-camera"), "OR native publisher did not publish field-camera video");
  assert(orTrackNames.includes("audio:or-room"), "OR native publisher did not publish room audio");

  const nonOrPublishedTrackCount = participants
    .filter((participant) => participant.identity !== "or-agent-native-publisher")
    .reduce((count, participant) => count + (participant.tracks?.length || 0), 0);
  assert(nonOrPublishedTrackCount === 0, "Subscriber participants unexpectedly published tracks");

  const nativeStopped = await nativeWorker.request("stop");
  await closePublisher(publisher);
  await disconnectAll();
  await roomClient.deleteRoom(roomId);
  await nativeWorker.shutdown();
  await dispose();

  const result = {
    status: "passed",
    schemaVersion: "smartst.or-agent-publisher-adapter-smoke.v0.1",
    livekitUrl: config.livekitUrl,
    businessUrl: config.businessUrl,
    callId: call.call.id,
    callStatus: accepted.call.status,
    roomId,
    roomCode: accepted.room.roomCode,
    mediaPolicy: accepted.room.mediaPolicy,
    nativeWorker: {
      launchMode: nativeWorker.launchMode,
      boundVideoChannels: nativeStarted.captureSession?.boundVideoChannels ?? 0,
      boundAudioEndpoints: nativeStarted.captureSession?.boundAudioEndpoints ?? 0,
      stoppedState: nativeStopped.captureSession?.state,
    },
    publisher: {
      identity: "or-agent-native-publisher",
      adapter: "native-worker-export-bridge",
      productionAdapter: "not-final",
      videoTrackName: "video:field-camera",
      audioTrackName: "audio:or-room",
      videoFramesPublished: publisher.videoFramesPublished,
      audioFramesPublished: publisher.audioFramesPublished,
      audioPacketsExported: publisher.audioPacketsExported,
    },
    desktopClient: {
      identity: "desktop-client-teaching-subscriber",
      joinedViaBusinessService: true,
      videoTrackNames: teachingTracks.videoTrackNames,
      audioTrackNames: teachingTracks.audioTrackNames,
      defaultTrackName: teachingToken.metadata.defaultTrackName,
      canPublish: teachingToken.grants.canPublish,
    },
    phoneObservers: observerTrackCollectors.map((collector, index) => ({
      identity: observerTokens[index].requestedIdentity,
      role: observerTokens[index].metadata.role,
      videoTrackNames: collector.videoTrackNames,
      audioTrackNames: collector.audioTrackNames,
      canPublish: observerTokens[index].grants.canPublish,
      canPublishData: observerTokens[index].grants.canPublishData,
    })),
    forwardingCheck: {
      orPublishedTrackCount: orTrackNames.length,
      nonOrPublishedTrackCount,
      observerCount: observerTokens.length,
    },
    boundary: {
      nativeWorkerPayloadSource: "real-media-foundation-wasapi-export",
      mediaBridge: "PPM/WAV file handoff for smoke only",
      rtcNodeStatus: "developer-preview",
      productionPublisherRequired: "native SDK/FFI/WHIP adapter without file handoff",
    },
    elapsedMs: Date.now() - startedAt.getTime(),
  };

  const outputPath = join(runtimeDir, "or-agent-publisher-smoke.json");
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  printJson({ ...result, outputPath });
} catch (error) {
  await disconnectAll().catch(() => undefined);
  await nativeWorker?.request("stop").catch(() => undefined);
  await nativeWorker?.shutdown().catch(() => undefined);
  if (roomClient && roomId) {
    await roomClient.deleteRoom(roomId).catch(() => undefined);
  }
  await dispose().catch(() => undefined);
  printJson({
    status: "failed",
    schemaVersion: "smartst.or-agent-publisher-adapter-smoke.v0.1",
    livekitUrl: config.livekitUrl,
    businessUrl: config.businessUrl,
    error: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    boundary: {
      productionPublisherRequired: "native SDK/FFI/WHIP adapter without file handoff",
    },
  });
  process.exitCode = 1;
}
}

async function publishNativeWorkerMedia(room, worker, options) {
  const firstVideo = await exportVideoFrame(worker, options);
  const firstAudio = await exportAudioFrame(worker, options);

  const videoSource = new VideoSource(firstVideo.width, firstVideo.height);
  const videoTrack = LocalVideoTrack.createVideoTrack("video:field-camera", videoSource);
  const videoOptions = new TrackPublishOptions();
  videoOptions.source = TrackSource.SOURCE_CAMERA;

  const audioSource = new AudioSource(firstAudio.sampleRate, firstAudio.channels);
  const audioTrack = LocalAudioTrack.createAudioTrack("audio:or-room", audioSource);
  const audioOptions = new TrackPublishOptions();
  audioOptions.source = TrackSource.SOURCE_MICROPHONE;

  resourcesToClose.push(videoTrack, audioTrack, videoSource, audioSource);

  await room.localParticipant.publishTrack(videoTrack, videoOptions);
  await room.localParticipant.publishTrack(audioTrack, audioOptions);

  const state = {
    videoFramesPublished: 0,
    audioFramesPublished: 0,
    audioPacketsExported: firstAudio.exportedPackets,
  };

  videoSource.captureFrame(
    new VideoFrame(firstVideo.rgb, firstVideo.width, firstVideo.height, VideoBufferType.RGB24),
    0n,
  );
  state.videoFramesPublished += 1;
  await audioSource.captureFrame(firstAudio.frame);
  state.audioFramesPublished += 1;

  const finished = Promise.all([
    publishVideoFramesFromWorker(videoSource, worker, options, state),
    publishAudioFramesFromWorker(audioSource, worker, options, state),
  ]).then(async () => {
    await audioSource.waitForPlayout();
  });

  return {
    get videoFramesPublished() {
      return state.videoFramesPublished;
    },
    get audioFramesPublished() {
      return state.audioFramesPublished;
    },
    get audioPacketsExported() {
      return state.audioPacketsExported;
    },
    finished,
    videoTrack,
    audioTrack,
    videoSource,
    audioSource,
  };
}

async function publishVideoFramesFromWorker(videoSource, worker, options, state) {
  const deadline = Date.now() + options.publishDurationMs;
  const intervalMs = Math.max(1, Math.round(1000 / options.videoFrameRate));
  let frameIndex = 1;
  while (Date.now() < deadline) {
    await delay(intervalMs);
    const frame = await exportVideoFrame(worker, options);
    videoSource.captureFrame(
      new VideoFrame(frame.rgb, frame.width, frame.height, VideoBufferType.RGB24),
      BigInt(frameIndex * intervalMs * 1000),
    );
    state.videoFramesPublished += 1;
    frameIndex += 1;
  }
}

async function publishAudioFramesFromWorker(audioSource, worker, options, state) {
  const deadline = Date.now() + options.publishDurationMs;
  while (Date.now() < deadline) {
    await delay(options.audioExportIntervalMs);
    const audio = await exportAudioFrame(worker, options);
    await audioSource.captureFrame(audio.frame);
    state.audioFramesPublished += 1;
    state.audioPacketsExported += audio.exportedPackets;
  }
}

async function exportVideoFrame(worker, options) {
  const outputPath = join(adapterRuntimeDir, `frame-${Date.now()}-${randomUUID()}.ppm`);
  const exported = await worker.request("exportVideoPayloadQueuePpm", {
    channelId: "field-camera",
    path: outputPath,
    maxFrames: 1,
    overwrite: true,
  });
  assert(exported.status === "exported", `video export did not return exported status: ${exported.status}`);
  assert(exported.consumedFrames > 0, "video export did not consume a frame");
  const bytes = await readFile(outputPath);
  const parsed = parsePpmWithPixels(bytes);
  if (options.expectedVideoWidth && parsed.width !== options.expectedVideoWidth) {
    throw new Error(`Unexpected video width ${parsed.width}; expected ${options.expectedVideoWidth}`);
  }
  return parsed;
}

async function exportAudioFrame(worker, options) {
  const outputPath = join(adapterRuntimeDir, `audio-${Date.now()}-${randomUUID()}.wav`);
  const exported = await worker.request("exportAudioPayloadQueueWav", {
    path: outputPath,
    maxPackets: options.audioPacketsPerExport,
    overwrite: true,
  });
  assert(exported.status === "exported", `audio export did not return exported status: ${exported.status}`);
  assert(exported.consumedPackets > 0, "audio export did not consume packets");
  const bytes = await readFile(outputPath);
  const parsed = parseWavWithPcm16(bytes);
  return {
    ...parsed,
    exportedPackets: exported.consumedPackets,
  };
}

function parsePpmWithPixels(bytes) {
  assert(bytes.toString("ascii", 0, 3) === "P6\n", "PPM output must use P6 format");
  const secondNewline = bytes.indexOf(0x0a, 3);
  const thirdNewline = bytes.indexOf(0x0a, secondNewline + 1);
  const [widthText, heightText] = bytes.toString("ascii", 3, secondNewline).split(" ");
  const width = Number.parseInt(widthText, 10);
  const height = Number.parseInt(heightText, 10);
  const maxValue = Number.parseInt(bytes.toString("ascii", secondNewline + 1, thirdNewline), 10);
  const pixelOffset = thirdNewline + 1;
  const pixelBytes = width * height * 3;
  assert(Number.isInteger(width) && width > 0, "PPM width is invalid");
  assert(Number.isInteger(height) && height > 0, "PPM height is invalid");
  assert(maxValue === 255, "PPM max value must be 255");
  assert(bytes.length === pixelOffset + pixelBytes, "PPM pixel bytes do not match dimensions");
  return {
    width,
    height,
    rgb: new Uint8Array(bytes.subarray(pixelOffset, pixelOffset + pixelBytes)),
  };
}

function parseWavWithPcm16(bytes) {
  assert(bytes.length >= 44, "WAV output is too small");
  assert(bytes.toString("ascii", 0, 4) === "RIFF", "WAV output missing RIFF header");
  assert(bytes.toString("ascii", 8, 12) === "WAVE", "WAV output missing WAVE header");
  assert(bytes.toString("ascii", 12, 16) === "fmt ", "WAV output missing fmt chunk");
  assert(bytes.toString("ascii", 36, 40) === "data", "WAV output missing data chunk");
  const audioFormat = bytes.readUInt16LE(20);
  const channels = bytes.readUInt16LE(22);
  const sampleRate = bytes.readUInt32LE(24);
  const blockAlign = bytes.readUInt16LE(32);
  const bitsPerSample = bytes.readUInt16LE(34);
  const dataBytes = bytes.readUInt32LE(40);
  const dataOffset = 44;
  assert(channels > 0, "WAV channel count is invalid");
  assert(sampleRate > 0, "WAV sample rate is invalid");
  assert(bytes.length >= dataOffset + dataBytes, "WAV data chunk is incomplete");
  const sampleCount = Math.floor(dataBytes / (bitsPerSample / 8));
  const pcm16 = new Int16Array(sampleCount);
  if (audioFormat === 1 && bitsPerSample === 16) {
    for (let index = 0; index < sampleCount; index += 1) {
      pcm16[index] = bytes.readInt16LE(dataOffset + index * 2);
    }
  } else if (audioFormat === 3 && bitsPerSample === 32) {
    for (let index = 0; index < sampleCount; index += 1) {
      const floatValue = bytes.readFloatLE(dataOffset + index * 4);
      pcm16[index] = Math.max(-32768, Math.min(32767, Math.round(floatValue * 32767)));
    }
  } else {
    throw new Error(`Unsupported WAV format: format=${audioFormat} bits=${bitsPerSample}`);
  }
  const samplesPerChannel = Math.floor(pcm16.length / channels);
  assert(samplesPerChannel > 0, "WAV output has no samples");
  return {
    sampleRate,
    channels,
    bitsPerSample,
    blockAlign,
    frame: new AudioFrame(pcm16, sampleRate, channels, samplesPerChannel),
  };
}

async function connectRoom(url, token, label) {
  const room = new Room();
  roomsToDisconnect.push(room);
  await room.connect(url, token, { autoSubscribe: true, dynacast: false });
  assert(room.isConnected, `${label} room did not connect`);
  return room;
}

function trackCollector(room) {
  const collector = {
    videoTrackNames: [],
    audioTrackNames: [],
  };
  room.on(RoomEvent.TrackSubscribed, (_track, publication) => {
    const name = publication.name || "";
    if (publication.kind === TrackKind.KIND_VIDEO && !collector.videoTrackNames.includes(name)) {
      collector.videoTrackNames.push(name);
    }
    if (publication.kind === TrackKind.KIND_AUDIO && !collector.audioTrackNames.includes(name)) {
      collector.audioTrackNames.push(name);
    }
  });
  return collector;
}

async function closePublisher(publisher) {
  await publisher.videoTrack.close().catch(() => undefined);
  await publisher.audioTrack.close().catch(() => undefined);
}

async function disconnectAll() {
  await Promise.all(roomsToDisconnect.map((room) => room.disconnect().catch(() => undefined)));
  await Promise.all(resourcesToClose.map((resource) => resource.close?.().catch(() => undefined)));
}

async function readConfig() {
  const processState = await readProcessState();
  const localKeys = await readLocalKeys();
  return {
    businessUrl: normalizeBaseUrl(
      process.env.SMARTST_LAB_BUSINESS_URL ||
        process.env.SMARTST_BUSINESS_URL ||
        processState.businessUrl ||
        "http://127.0.0.1:4780",
    ),
    livekitUrl: process.env.LIVEKIT_URL?.trim() || processState.livekitUrl || "ws://127.0.0.1:7880",
    apiKey: process.env.LIVEKIT_API_KEY?.trim() || localKeys.apiKey,
    apiSecret: process.env.LIVEKIT_API_SECRET?.trim() || localKeys.apiSecret,
    timeoutMs: Number.parseInt(process.env.SMARTST_OR_PUBLISHER_TIMEOUT_MS || "20000", 10),
    initialNativeHoldMs: Number.parseInt(process.env.SMARTST_OR_PUBLISHER_NATIVE_HOLD_MS || "1200", 10),
    publishDurationMs: Number.parseInt(process.env.SMARTST_OR_PUBLISHER_DURATION_MS || "3000", 10),
    videoFrameRate: Number.parseInt(process.env.SMARTST_OR_PUBLISHER_FPS || "4", 10),
    expectedVideoWidth: Number.parseInt(process.env.SMARTST_OR_PUBLISHER_EXPECTED_WIDTH || "0", 10),
    videoMediaTypeIndex: Number.parseInt(process.env.SMARTST_NATIVE_VIDEO_MEDIA_TYPE_INDEX || "0", 10),
    videoFrameQueueCapacity: Number.parseInt(process.env.SMARTST_OR_PUBLISHER_VIDEO_QUEUE || "8", 10),
    audioIndex: Number.parseInt(process.env.SMARTST_NATIVE_AUDIO_INDEX || "0", 10),
    audioPayloadQueueCapacity: Number.parseInt(process.env.SMARTST_OR_PUBLISHER_AUDIO_QUEUE || "100", 10),
    audioPacketsPerExport: Number.parseInt(process.env.SMARTST_OR_PUBLISHER_AUDIO_PACKETS || "10", 10),
    audioExportIntervalMs: Number.parseInt(process.env.SMARTST_OR_PUBLISHER_AUDIO_INTERVAL_MS || "200", 10),
    observerCount: Number.parseInt(process.env.SMARTST_OR_PUBLISHER_OBSERVERS || "1", 10),
    nativeWorker: {
      executablePath: process.env.SMARTST_OR_AGENT_NATIVE_WORKER_EXE,
    },
  };
}

async function readProcessState() {
  try {
    return JSON.parse(stripBom(await readFile(processStateFile, "utf8")));
  } catch {
    return {};
  }
}

async function readLocalKeys() {
  try {
    const text = stripBom(await readFile(keyFile, "utf8"));
    const line = text.split(/\r?\n/).find((candidate) => candidate.trim());
    const match = line?.match(/^([^:]+):\s*(.+)$/);
    if (!match) return {};
    return {
      apiKey: match[1].trim(),
      apiSecret: match[2].trim(),
    };
  } catch {
    return {};
  }
}

async function postJson(url, body, expectedStatus = 200) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (response.status !== expectedStatus) {
    throw new Error(`${url} expected ${expectedStatus}, got ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

class NativeWorkerBridge {
  constructor(child, launchMode) {
    this.child = child;
    this.launchMode = launchMode;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.stderr = "";
    this.exited = false;
  }

  static async launch(options) {
    const launch = await resolveNativeWorkerLaunch(options);
    const child = spawn(launch.command, launch.args, {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const bridge = new NativeWorkerBridge(child, launch.mode);
    const ready = bridge.waitForReady();
    bridge.attach();
    await ready;
    return bridge;
  }

  attach() {
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.stdoutBuffer += chunk;
      let newlineIndex = this.stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = this.stdoutBuffer.slice(0, newlineIndex);
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
        this.handleLine(line);
        newlineIndex = this.stdoutBuffer.indexOf("\n");
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.child.on("close", (exitCode) => {
      this.exited = true;
      const error = new Error(`Native Worker exited with code ${exitCode}. stderr=${this.stderr}`);
      for (const handler of this.pending.values()) {
        handler.reject(error);
      }
      this.pending.clear();
      this.readyReject?.(error);
    });
  }

  waitForReady(timeoutMs = 30000) {
    return new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        rejectPromise(new Error(`Native Worker ready timed out. stderr=${this.stderr}`));
      }, timeoutMs);
      this.readyResolve = () => {
        clearTimeout(timeout);
        resolvePromise();
      };
      this.readyReject = (error) => {
        clearTimeout(timeout);
        rejectPromise(error);
      };
    });
  }

  request(method, params, timeoutMs = 30000) {
    if (this.exited) {
      return Promise.reject(new Error("Native Worker is not running"));
    }
    const id = `${method}-${Date.now()}-${Math.random()}`;
    const result = new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`${method} timed out. stderr=${this.stderr}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          rejectPromise(error);
        },
      });
    });
    this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return result;
  }

  handleLine(line) {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (message.type === "event" && message.event?.category === "worker" && message.event?.name === "ready") {
      this.readyResolve?.();
      return;
    }
    if (message.type !== "response") return;
    const handler = this.pending.get(message.id);
    if (!handler) return;
    this.pending.delete(message.id);
    if (message.ok) {
      handler.resolve(message.result);
      return;
    }
    handler.reject(new Error(message.error?.message || "Native Worker response failed"));
  }

  async shutdown() {
    if (!this.exited) {
      await this.request("shutdown").catch(() => undefined);
    }
    this.child.stdin.end();
    this.child.kill();
  }
}

async function resolveNativeWorkerLaunch(options) {
  if (options.executablePath) {
    return {
      mode: "explicit-exe",
      command: options.executablePath,
      args: [],
    };
  }
  const releaseExe = join(repoRoot, "native-worker", "target", "release", "smartst-native-worker.exe");
  if (await fileExists(releaseExe)) {
    return {
      mode: "release-exe",
      command: releaseExe,
      args: [],
    };
  }
  return {
    mode: "cargo-run",
    command: "cargo",
    args: ["run", "--quiet", "--manifest-path", join(repoRoot, "native-worker", "Cargo.toml")],
  };
}

async function fileExists(path) {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(100);
  }
  throw new Error(label);
}

function livekitApiHostFromUrl(livekitUrl) {
  const url = new URL(livekitUrl);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  } else if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported LIVEKIT_URL protocol: ${url.protocol}`);
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function normalizeBaseUrl(value) {
  return value.trim().replace(/\/+$/, "");
}

function timestampForPath(date) {
  return date.toISOString().replace(/\D/g, "").slice(0, 14);
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

await main();
