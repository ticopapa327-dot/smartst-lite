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
import { RoomServiceClient } from "livekit-server-sdk";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const runtimeDir = join(repoRoot, "runtime", "or-connectivity");
const processStateFile = join(runtimeDir, "processes.json");
const keyFile = join(runtimeDir, "livekit.keys");
const startedAt = new Date();

const config = await readConfig();
const roomsToDisconnect = [];
const resourcesToClose = [];
let roomClient;
let roomId;

try {
  roomId = `smartst-media-${timestampForPath(startedAt)}`;
  const roomCode = `ST-MEDIA-${timestampForPath(startedAt).slice(0, 8)}-${timestampForPath(startedAt).slice(8)}`;
  roomClient = new RoomServiceClient(
    livekitApiHostFromUrl(config.livekitUrl),
    config.apiKey,
    config.apiSecret,
    { requestTimeout: config.timeoutMs },
  );

  await roomClient.createRoom({
    name: roomId,
    emptyTimeout: 600,
    departureTimeout: 30,
    maxParticipants: 16,
    metadata: JSON.stringify({
      purpose: "smartst-livekit-media-smoke",
      roomCode,
      createdAt: startedAt.toISOString(),
    }),
  });

  const businessRoom = await postJson(`${config.businessUrl}/api/rooms`, {
    roomId,
    roomCode,
    mode: "interactive",
    defaultChannelId: "field-camera",
    limits: {
      maxInteractiveParticipants: 4,
      maxTabletClients: 2,
      maxWebObservers: config.observerCount,
    },
  }, 201);

  const orHostToken = await issueRoomToken(roomId, {
    clientType: "or-windows",
    identity: "or-agent-synthetic-publisher",
    mode: "interactive",
  });
  const teachingToken = await issueRoomToken(roomId, {
    clientType: "teaching-windows",
    identity: "desktop-teaching-subscriber",
    mode: "interactive",
  });
  const observerTokens = [];
  for (let index = 0; index < config.observerCount; index += 1) {
    const identity = `phone-observer-${String(index + 1).padStart(2, "0")}`;
    const observerToken = await postJson(`${config.businessUrl}/api/observer/token`, {
      roomCode,
      identity,
    });
    observerToken.requestedIdentity = identity;
    observerTokens.push(observerToken);
  }

  assert(orHostToken.grants.canPublish === true, "OR host token cannot publish");
  assert(teachingToken.grants.canPublish === true, "teaching interactive token cannot publish");
  for (const observerToken of observerTokens) {
    assert(observerToken.grants.canPublish === false, "phone observer can publish");
    assert(observerToken.grants.canPublishData === false, "phone observer can publish data");
  }

  const teachingRoom = await connectRoom(config.livekitUrl, teachingToken.token, "teaching");
  const observerRooms = [];
  for (const token of observerTokens) {
    observerRooms.push(await connectRoom(config.livekitUrl, token.token, token.metadata.role));
  }
  const orRoom = await connectRoom(config.livekitUrl, orHostToken.token, "or-host");

  const teachingTracks = trackCollector(teachingRoom);
  const observerTrackCollectors = observerRooms.map(trackCollector);

  const publisher = await publishSyntheticOrMedia(orRoom, {
    width: config.videoWidth,
    height: config.videoHeight,
    durationMs: config.durationMs,
    frameRate: config.frameRate,
    audioSampleRate: 48_000,
    audioChannels: 1,
  });

  await waitFor(
    () =>
      teachingTracks.videoTrackNames.includes("video:field-camera") &&
      teachingTracks.audioTrackNames.includes("audio:or-room"),
    config.timeoutMs,
    "teaching subscriber did not receive OR audio/video tracks",
  );

  for (let index = 0; index < observerTrackCollectors.length; index += 1) {
    const collector = observerTrackCollectors[index];
    await waitFor(
      () =>
        collector.videoTrackNames.includes("video:field-camera") &&
        collector.audioTrackNames.includes("audio:or-room"),
      config.timeoutMs,
      `phone observer ${index + 1} did not receive OR audio/video tracks`,
    );
  }

  await publisher.finished;
  await delay(500);

  const participants = await roomClient.listParticipants(roomId);
  const orParticipant = participants.find(
    (participant) => participant.identity === "or-agent-synthetic-publisher",
  );
  assert(orParticipant, "OR publisher participant is missing from LiveKit");
  const orTrackNames = (orParticipant.tracks || []).map((track) => track.name).sort();
  assert(orTrackNames.includes("video:field-camera"), "OR participant did not publish field-camera video");
  assert(orTrackNames.includes("audio:or-room"), "OR participant did not publish room audio");

  const nonOrPublishedTrackCount = participants
    .filter((participant) => participant.identity !== "or-agent-synthetic-publisher")
    .reduce((count, participant) => count + (participant.tracks?.length || 0), 0);
  assert(nonOrPublishedTrackCount === 0, "subscriber participants unexpectedly published tracks");

  await closePublisher(publisher);
  await disconnectAll();
  await roomClient.deleteRoom(roomId);
  await dispose();

  const result = {
    status: "passed",
    schemaVersion: "smartst.livekit-media-smoke.v0.1",
    livekitUrl: config.livekitUrl,
    businessUrl: config.businessUrl,
    roomId,
    roomCode,
    defaultChannelId: businessRoom.room.mediaPolicy.defaultChannelId,
    defaultTrackName: businessRoom.room.mediaPolicy.defaultTrackName,
    observerCount: observerTokens.length,
    publisher: {
      identity: "or-agent-synthetic-publisher",
      videoTrackName: "video:field-camera",
      audioTrackName: "audio:or-room",
      videoFramesPushed: publisher.videoFramesPushed,
      audioFramesPushed: publisher.audioFramesPushed,
    },
    teachingSubscriber: {
      videoTrackNames: teachingTracks.videoTrackNames,
      audioTrackNames: teachingTracks.audioTrackNames,
      canPublish: teachingToken.grants.canPublish,
    },
    phoneObservers: observerTrackCollectors.map((collector, index) => ({
      identity: observerTokens[index].requestedIdentity || `phone-observer-${index + 1}`,
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
      publisherType: "synthetic-or-media",
      productionOrAgentPublisher: "not-implemented",
      rtcNodeStatus: "developer-preview",
    },
    elapsedMs: Date.now() - startedAt.getTime(),
  };

  const outputPath = join(runtimeDir, "livekit-media-smoke.json");
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  printJson({ ...result, outputPath });
} catch (error) {
  await disconnectAll().catch(() => undefined);
  if (roomClient && roomId) {
    await roomClient.deleteRoom(roomId).catch(() => undefined);
  }
  await dispose().catch(() => undefined);
  printJson({
    status: "failed",
    schemaVersion: "smartst.livekit-media-smoke.v0.1",
    livekitUrl: config.livekitUrl,
    businessUrl: config.businessUrl,
    error: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    boundary: {
      productionOrAgentPublisher: "not-implemented",
      rtcNodeStatus: "developer-preview",
    },
  });
  process.exitCode = 1;
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
    observerCount: Number.parseInt(process.env.SMARTST_MEDIA_SMOKE_OBSERVERS || "3", 10),
    durationMs: Number.parseInt(process.env.SMARTST_MEDIA_SMOKE_DURATION_MS || "2500", 10),
    timeoutMs: Number.parseInt(process.env.SMARTST_MEDIA_SMOKE_TIMEOUT_MS || "15000", 10),
    frameRate: Number.parseInt(process.env.SMARTST_MEDIA_SMOKE_FPS || "10", 10),
    videoWidth: Number.parseInt(process.env.SMARTST_MEDIA_SMOKE_WIDTH || "320", 10),
    videoHeight: Number.parseInt(process.env.SMARTST_MEDIA_SMOKE_HEIGHT || "180", 10),
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

async function issueRoomToken(roomId, body) {
  return postJson(`${config.businessUrl}/api/rooms/${roomId}/tokens`, body);
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

async function publishSyntheticOrMedia(room, options) {
  const videoSource = new VideoSource(options.width, options.height);
  const videoTrack = LocalVideoTrack.createVideoTrack("video:field-camera", videoSource);
  const videoOptions = new TrackPublishOptions();
  videoOptions.source = TrackSource.SOURCE_CAMERA;

  const audioSource = new AudioSource(options.audioSampleRate, options.audioChannels);
  const audioTrack = LocalAudioTrack.createAudioTrack("audio:or-room", audioSource);
  const audioOptions = new TrackPublishOptions();
  audioOptions.source = TrackSource.SOURCE_MICROPHONE;

  resourcesToClose.push(videoTrack, audioTrack, videoSource, audioSource);

  await room.localParticipant.publishTrack(videoTrack, videoOptions);
  await room.localParticipant.publishTrack(audioTrack, audioOptions);

  const state = {
    videoFramesPushed: 0,
    audioFramesPushed: 0,
  };

  const finished = Promise.all([
    pushVideoFrames(videoSource, options, state),
    pushAudioFrames(audioSource, options, state),
  ]);

  return {
    ...state,
    get videoFramesPushed() {
      return state.videoFramesPushed;
    },
    get audioFramesPushed() {
      return state.audioFramesPushed;
    },
    finished,
    videoTrack,
    audioTrack,
    videoSource,
    audioSource,
  };
}

async function pushVideoFrames(videoSource, options, state) {
  const intervalMs = Math.max(1, Math.round(1000 / options.frameRate));
  const deadline = Date.now() + options.durationMs;
  let frameIndex = 0;
  while (Date.now() < deadline) {
    const frame = createRgbFrame(options.width, options.height, frameIndex);
    videoSource.captureFrame(frame, BigInt(frameIndex * intervalMs * 1000));
    state.videoFramesPushed += 1;
    frameIndex += 1;
    await delay(intervalMs);
  }
}

async function pushAudioFrames(audioSource, options, state) {
  const samplesPer10Ms = Math.floor(options.audioSampleRate / 100);
  const deadline = Date.now() + options.durationMs;
  let sampleCursor = 0;
  while (Date.now() < deadline) {
    const frame = AudioFrame.create(
      options.audioSampleRate,
      options.audioChannels,
      samplesPer10Ms,
    );
    for (let index = 0; index < samplesPer10Ms; index += 1) {
      const value = Math.round(
        0.25 * 32767 * Math.sin((2 * Math.PI * 440 * sampleCursor) / options.audioSampleRate),
      );
      sampleCursor += 1;
      for (let channel = 0; channel < options.audioChannels; channel += 1) {
        frame.data[index * options.audioChannels + channel] = value;
      }
    }
    await audioSource.captureFrame(frame);
    state.audioFramesPushed += 1;
  }
  await audioSource.waitForPlayout();
}

function createRgbFrame(width, height, frameIndex) {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      data[offset] = (x + frameIndex * 7) % 256;
      data[offset + 1] = (y * 2 + frameIndex * 3) % 256;
      data[offset + 2] = (x + y + frameIndex * 11) % 256;
    }
  }
  return new VideoFrame(data, width, height, VideoBufferType.RGB24);
}

async function closePublisher(publisher) {
  await publisher.videoTrack.close().catch(() => undefined);
  await publisher.audioTrack.close().catch(() => undefined);
}

async function disconnectAll() {
  await Promise.all(roomsToDisconnect.map((room) => room.disconnect().catch(() => undefined)));
  await Promise.all(resourcesToClose.map((resource) => resource.close?.().catch(() => undefined)));
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
