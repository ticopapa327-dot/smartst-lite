import { randomUUID } from "node:crypto";
import { RoomServiceClient } from "livekit-server-sdk";
import { createBusinessServiceServer } from "./server.mjs";

const REQUIRED_ENV = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"];

const startedAt = new Date();
const config = readConfig();

if (config.missingEnv.length > 0) {
  printJson({
    status: "blocked",
    schemaVersion: "ust.livekit-preflight.v0.1",
    error: "missing-livekit-env",
    message: "LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required for real LiveKit preflight.",
    missingEnv: config.missingEnv,
    requiredEnv: REQUIRED_ENV,
  });
  process.exit(2);
}

const roomName =
  process.env.UST_LIVEKIT_PREFLIGHT_ROOM ||
  `ust-preflight-${timestampForPath(startedAt)}-${randomUUID().slice(0, 8)}`;
const roomCode =
  process.env.UST_LIVEKIT_PREFLIGHT_ROOM_CODE ||
  `ST-LK-${timestampForPath(startedAt).slice(0, 8)}`;
const keepRoom = envTruthy("UST_LIVEKIT_PREFLIGHT_KEEP_ROOM");
const requestTimeoutMs = Number.parseInt(
  process.env.UST_LIVEKIT_PREFLIGHT_TIMEOUT_MS || "10000",
  10,
);

let businessServer;
let roomClient;
let livekitRoomCreated = false;
let livekitRoomDeleted = false;

try {
  const livekitApiHost = livekitApiHostFromUrl(config.livekitUrl);
  roomClient = new RoomServiceClient(livekitApiHost, config.apiKey, config.apiSecret, {
    requestTimeout: requestTimeoutMs,
  });

  const createdLiveKitRoom = await roomClient.createRoom({
    name: roomName,
    emptyTimeout: 60,
    departureTimeout: 20,
    maxParticipants: 4,
    metadata: JSON.stringify({
      purpose: "ust-livekit-preflight",
      createdAt: startedAt.toISOString(),
    }),
  });
  livekitRoomCreated = true;

  const listedRooms = await roomClient.listRooms([roomName]);
  assert(
    listedRooms.some((room) => room.name === roomName),
    "LiveKit RoomService listRooms did not return the preflight room.",
  );

  const participants = await roomClient.listParticipants(roomName);
  assert(Array.isArray(participants), "LiveKit listParticipants did not return an array.");

  const service = createBusinessServiceServer({
    tokenMode: "real",
    livekitUrl: config.livekitUrl,
    livekitApiKey: config.apiKey,
    livekitApiSecret: config.apiSecret,
    livekitTokenTtlSeconds: 900,
    limits: {
      maxInteractiveParticipants: 2,
      maxTabletClients: 1,
      maxWebObservers: 1,
    },
  });
  businessServer = service.server;
  const baseUrl = await listenOnRandomPort(businessServer);

  const roomResponse = await post(baseUrl, "/api/rooms", {
    roomId: roomName,
    roomCode,
    mode: "interactive",
    defaultChannelId: "field-camera",
    limits: {
      maxInteractiveParticipants: 2,
      maxTabletClients: 1,
      maxWebObservers: 1,
    },
  }, 201);

  const hostToken = await post(baseUrl, `/api/rooms/${roomName}/tokens`, {
    clientType: "or-windows",
    identity: "or-livekit-preflight",
    mode: "interactive",
  });

  const observerToken = await post(baseUrl, "/api/observer/token", {
    roomCode,
    identity: "phone-livekit-preflight",
  });

  assert(hostToken.tokenType === "real", "host token is not real mode.");
  assert(observerToken.tokenType === "real", "observer token is not real mode.");
  assert(!hostToken.token.startsWith("mock."), "host token is still mock.");
  assert(!observerToken.token.startsWith("mock."), "observer token is still mock.");

  const hostPayload = decodeJwtPayload(hostToken.token);
  const observerPayload = decodeJwtPayload(observerToken.token);
  assert(hostPayload.iss === config.apiKey, "host JWT issuer does not match API key.");
  assert(observerPayload.iss === config.apiKey, "observer JWT issuer does not match API key.");
  assert(hostPayload.video?.room === roomName, "host JWT room does not match preflight room.");
  assert(observerPayload.video?.room === roomName, "observer JWT room does not match preflight room.");
  assert(hostPayload.video?.canPublish === true, "host JWT cannot publish.");
  assert(observerPayload.video?.canPublish === false, "observer JWT can publish.");
  assert(observerPayload.video?.canSubscribe === true, "observer JWT cannot subscribe.");
  assert(observerPayload.video?.canPublishData === false, "observer JWT can publish data.");
  assert(JSON.parse(observerPayload.metadata).mode === "watch-only", "observer JWT metadata is not watch-only.");
  assert(hostToken.metadata.defaultChannelId === "field-camera", "host token response lost default channel.");
  assert(observerToken.metadata.defaultTrackName === "video:field-camera", "observer token response lost default track.");

  const cleanupError = await cleanupPreflightRoom();
  if (cleanupError) {
    throw new Error(cleanupError);
  }

  printJson({
    status: "passed",
    schemaVersion: "ust.livekit-preflight.v0.1",
    livekitUrl: config.livekitUrl,
    livekitApiHost,
    roomName,
    roomCode: roomResponse.room.roomCode,
    createdRoomName: createdLiveKitRoom.name,
    listedRoomCount: listedRooms.length,
    participantCount: participants.length,
    businessService: {
      baseUrl,
      tokenMode: hostToken.tokenType,
      defaultChannelId: roomResponse.room.mediaPolicy.defaultChannelId,
      defaultTrackName: roomResponse.room.mediaPolicy.defaultTrackName,
      startupVideoMode: roomResponse.room.mediaPolicy.startupVideoMode,
      hostCanPublish: hostToken.grants.canPublish,
      observerCanPublish: observerToken.grants.canPublish,
      observerCanSubscribe: observerToken.grants.canSubscribe,
    },
    cleanup: {
      keepRoom,
      livekitRoomCreated,
      livekitRoomDeleted,
    },
    elapsedMs: Date.now() - startedAt.getTime(),
  });
} catch (error) {
  const cleanupError = await cleanupPreflightRoom();
  printJson({
    status: "failed",
    schemaVersion: "ust.livekit-preflight.v0.1",
    livekitUrl: config.livekitUrl || undefined,
    roomName,
    error: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    cleanup: {
      keepRoom,
      livekitRoomCreated,
      livekitRoomDeleted,
      cleanupError,
    },
  });
  process.exitCode = 1;
} finally {
  if (businessServer) {
    await new Promise((resolve) => businessServer.close(resolve));
  }
}

async function cleanupPreflightRoom() {
  if (keepRoom || !roomClient || !livekitRoomCreated || livekitRoomDeleted) {
    return undefined;
  }

  try {
    await roomClient.deleteRoom(roomName);
    livekitRoomDeleted = true;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function readConfig() {
  const livekitUrl = process.env.LIVEKIT_URL?.trim() || "";
  const apiKey = process.env.LIVEKIT_API_KEY?.trim() || "";
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim() || "";
  const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
  return {
    livekitUrl,
    apiKey,
    apiSecret,
    missingEnv,
  };
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

async function listenOnRandomPort(serverInstance) {
  await new Promise((resolve) => {
    serverInstance.listen(0, "127.0.0.1", resolve);
  });
  const address = serverInstance.address();
  return `http://127.0.0.1:${address.port}`;
}

async function post(baseUrl, path, body, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (response.status !== expectedStatus) {
    throw new Error(
      `${path} expected ${expectedStatus}, got ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

function decodeJwtPayload(token) {
  const parts = token.split(".");
  assert(parts.length === 3, "JWT has three parts.");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

function timestampForPath(date) {
  return date.toISOString().replace(/\D/g, "").slice(0, 14);
}

function envTruthy(name) {
  return ["1", "true", "yes", "on"].includes((process.env[name] || "").trim().toLowerCase());
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
