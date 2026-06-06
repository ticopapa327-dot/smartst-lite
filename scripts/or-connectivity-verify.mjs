import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RoomServiceClient } from "livekit-server-sdk";

const repoRoot = resolve(import.meta.dirname, "..");
const runtimeDir = join(repoRoot, "runtime", "or-connectivity");
const keyFile = join(runtimeDir, "livekit.keys");
const processStateFile = join(runtimeDir, "processes.json");

const startedAt = new Date();
const config = await readConfig();

try {
  await mkdir(runtimeDir, { recursive: true });

  const health = await getJson(`${config.businessUrl}/health`);
  assert(health.ok === true, "business service health is not ok");

  const roomClient = new RoomServiceClient(
    livekitApiHostFromUrl(config.livekitUrl),
    config.apiKey,
    config.apiSecret,
    { requestTimeout: config.timeoutMs },
  );

  const existingRooms = await roomClient.listRooms([config.roomId]);
  let livekitRoomCreated = false;
  if (!existingRooms.some((room) => room.name === config.roomId)) {
    await roomClient.createRoom({
      name: config.roomId,
      emptyTimeout: 600,
      departureTimeout: 30,
      maxParticipants: 16,
      metadata: JSON.stringify({
        purpose: "ust-or-connectivity-lab",
        roomCode: config.roomCode,
        createdAt: startedAt.toISOString(),
      }),
    });
    livekitRoomCreated = true;
  }

  const listedRooms = await roomClient.listRooms([config.roomId]);
  assert(
    listedRooms.some((room) => room.name === config.roomId),
    "LiveKit RoomService cannot list lab room",
  );

  const businessRoom = await postJson(`${config.businessUrl}/api/rooms`, {
    roomId: config.roomId,
    roomCode: config.roomCode,
    mode: "interactive",
    defaultChannelId: "field-camera",
    limits: {
      maxInteractiveParticipants: 4,
      maxTabletClients: 2,
      maxWebObservers: 10,
    },
  }, 201);

  const orHost = await postJson(`${config.businessUrl}/api/rooms/${config.roomId}/tokens`, {
    clientType: "or-windows",
    identity: "or-lab-host",
    mode: "interactive",
  });

  const teachingWatch = await postJson(`${config.businessUrl}/api/rooms/${config.roomId}/tokens`, {
    clientType: "teaching-windows",
    identity: "teaching-lab-watch",
    mode: "watch",
  });

  const teachingInteractive = await postJson(`${config.businessUrl}/api/rooms/${config.roomId}/tokens`, {
    clientType: "teaching-windows",
    identity: "teaching-lab-interactive",
    mode: "interactive",
  });

  const phoneObserver = await postJson(`${config.businessUrl}/api/observer/token`, {
    roomCode: config.roomCode,
    identity: "phone-lab-observer",
  });

  assert(orHost.tokenType === "real", "OR host token is not real JWT");
  assert(teachingWatch.tokenType === "real", "teaching watch token is not real JWT");
  assert(teachingInteractive.tokenType === "real", "teaching interactive token is not real JWT");
  assert(phoneObserver.tokenType === "real", "phone observer token is not real JWT");
  assert(orHost.grants.canPublish === true, "OR host cannot publish");
  assert(teachingWatch.grants.canPublish === false, "teaching watch token can publish");
  assert(teachingInteractive.grants.canPublish === true, "teaching interactive token cannot publish");
  assert(phoneObserver.grants.canPublish === false, "phone observer can publish");
  assert(phoneObserver.grants.canPublishData === false, "phone observer can publish data");
  assert(phoneObserver.metadata.defaultTrackName === "video:field-camera", "observer default track mismatch");

  const session = {
    schemaVersion: "ust.or-connectivity-lab.session.v0.1",
    createdAt: startedAt.toISOString(),
    businessUrl: config.businessUrl,
    livekitUrl: config.livekitUrl,
    roomId: config.roomId,
    roomCode: config.roomCode,
    webObserverUrl: config.webObserverUrl,
    mediaPolicy: businessRoom.room.mediaPolicy,
    tokens: {
      orHost,
      teachingWatch,
      teachingInteractive,
      phoneObserver,
    },
  };

  const sessionPath = join(runtimeDir, "session.json");
  await writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");

  printJson({
    status: "passed",
    schemaVersion: "ust.or-connectivity-lab.verify.v0.1",
    businessUrl: config.businessUrl,
    livekitUrl: config.livekitUrl,
    roomId: config.roomId,
    roomCode: config.roomCode,
    webObserverUrl: config.webObserverUrl,
    livekitRoomCreated,
    defaultChannelId: businessRoom.room.mediaPolicy.defaultChannelId,
    defaultTrackName: businessRoom.room.mediaPolicy.defaultTrackName,
    tokenChecks: {
      orHostCanPublish: orHost.grants.canPublish,
      teachingWatchCanPublish: teachingWatch.grants.canPublish,
      teachingInteractiveCanPublish: teachingInteractive.grants.canPublish,
      phoneObserverCanPublish: phoneObserver.grants.canPublish,
      phoneObserverCanPublishData: phoneObserver.grants.canPublishData,
    },
    sessionPath,
    elapsedMs: Date.now() - startedAt.getTime(),
  });
} catch (error) {
  printJson({
    status: "failed",
    schemaVersion: "ust.or-connectivity-lab.verify.v0.1",
    businessUrl: config.businessUrl,
    livekitUrl: config.livekitUrl,
    roomId: config.roomId,
    roomCode: config.roomCode,
    error: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}

async function readConfig() {
  const localKeys = await readLocalKeys();
  const processState = await readProcessState();
  const businessUrl = normalizeBaseUrl(
    process.env.UST_LAB_BUSINESS_URL ||
      process.env.UST_BUSINESS_URL ||
      processState.businessUrl ||
      "http://127.0.0.1:4780",
  );
  const livekitUrl = process.env.LIVEKIT_URL?.trim() || processState.livekitUrl || "ws://127.0.0.1:7880";
  const apiKey = process.env.LIVEKIT_API_KEY?.trim() || localKeys.apiKey;
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim() || localKeys.apiSecret;
  const roomStamp = timestampForPath(startedAt);

  if (!apiKey || !apiSecret) {
    throw new Error(
      "LIVEKIT_API_KEY/LIVEKIT_API_SECRET are required, or run connectivity:or-lab:start first.",
    );
  }

  return {
    businessUrl,
    livekitUrl,
    apiKey,
    apiSecret,
    roomId: process.env.UST_LAB_ROOM_ID || `ust-lab-${roomStamp}`,
    roomCode: process.env.UST_LAB_ROOM_CODE || `ST-LAB-${roomStamp.slice(0, 8)}-${roomStamp.slice(8)}`,
    webObserverUrl: process.env.UST_LAB_WEB_OBSERVER_URL || processState.webObserverUrl || "",
    timeoutMs: Number.parseInt(process.env.UST_LAB_TIMEOUT_MS || "8000", 10),
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

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

async function getJson(url) {
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${url} expected 2xx, got ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}
