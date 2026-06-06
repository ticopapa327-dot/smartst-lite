import http from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { AccessToken } from "livekit-server-sdk";

const DEFAULT_LIMITS = Object.freeze({
  maxInteractiveParticipants: 4,
  maxTabletClients: 2,
  maxWebObservers: 10,
});

const VALID_CLIENT_TYPES = new Set([
  "or-windows",
  "teaching-windows",
  "tablet-client",
  "web-observer",
]);

const VALID_ROOM_MODES = new Set(["watch", "interactive", "conference"]);
const DEFAULT_VIDEO_CHANNELS = Object.freeze([
  {
    id: "field-camera",
    displayName: "术野摄像机",
    enabled: true,
    health: "unknown",
    localPrimary: true,
    remoteDefault: true,
    priority: 10,
    trackName: "video:field-camera",
  },
  {
    id: "panorama",
    displayName: "全景摄像机",
    enabled: true,
    health: "unknown",
    localPrimary: false,
    remoteDefault: false,
    priority: 20,
    trackName: "video:panorama",
  },
  {
    id: "endoscope",
    displayName: "腹腔镜 / 内镜",
    enabled: true,
    health: "unknown",
    localPrimary: false,
    remoteDefault: false,
    priority: 30,
    trackName: "video:endoscope",
  },
  {
    id: "aux-device",
    displayName: "辅助医疗设备",
    enabled: true,
    health: "unknown",
    localPrimary: false,
    remoteDefault: false,
    priority: 40,
    trackName: "video:aux-device",
  },
]);

function createTokenConfig(options) {
  const mode = options.tokenMode || process.env.LIVEKIT_TOKEN_MODE || "mock";
  if (!["mock", "real"].includes(mode)) {
    throw new Error(`Invalid token mode: ${mode}`);
  }

  return {
    mode,
    livekitUrl: options.livekitUrl || process.env.LIVEKIT_URL || "ws://127.0.0.1:7880",
    apiKey: options.livekitApiKey || process.env.LIVEKIT_API_KEY,
    apiSecret: options.livekitApiSecret || process.env.LIVEKIT_API_SECRET,
    ttlSeconds: Number.parseInt(options.livekitTokenTtlSeconds || process.env.LIVEKIT_TOKEN_TTL_SECONDS || "3600", 10),
  };
}

export function createBusinessServiceServer(options = {}) {
  const state = {
    endpoints: new Map(),
    calls: new Map(),
    rooms: new Map(),
    issuedTokens: [],
    limits: {
      ...DEFAULT_LIMITS,
      ...(options.limits ?? {}),
    },
    tokenConfig: createTokenConfig(options),
  };

  const server = http.createServer(async (request, response) => {
    try {
      await handleRequest(request, response, state);
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(response, error.statusCode, {
          error: error.error,
          message: error.message,
        });
        return;
      }

      sendJson(response, 500, {
        error: "internal-error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  return { server, state };
}

async function handleRequest(request, response, state) {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const segments = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      service: "smartst-business-service-poc",
      time: new Date().toISOString(),
    });
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/endpoints/register"
  ) {
    const body = await readJson(request);
    const endpoint = registerEndpoint(state, body);
    sendJson(response, 200, { endpoint });
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/endpoints/heartbeat"
  ) {
    const body = await readJson(request);
    const endpoint = heartbeatEndpoint(state, body);
    sendJson(response, 200, { endpoint });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/endpoints") {
    const type = url.searchParams.get("type");
    const endpoints = [...state.endpoints.values()].filter((endpoint) =>
      type ? endpoint.clientType === type || endpoint.tags.includes(type) : true,
    );
    sendJson(response, 200, { endpoints });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/calls") {
    const body = await readJson(request);
    const call = createCall(state, body);
    sendJson(response, 201, { call });
    return;
  }

  if (
    request.method === "POST" &&
    segments.length === 4 &&
    segments[0] === "api" &&
    segments[1] === "calls"
  ) {
    const callId = segments[2];
    const action = segments[3];
    const body = await readJson(request);

    if (action === "accept") {
      const result = await acceptCall(state, callId, body);
      sendJson(response, 200, result);
      return;
    }

    if (action === "reject") {
      const call = updateCallStatus(state, callId, "rejected");
      sendJson(response, 200, { call });
      return;
    }

    if (action === "hangup") {
      const call = updateCallStatus(state, callId, "ended");
      sendJson(response, 200, { call });
      return;
    }
  }

  if (request.method === "POST" && url.pathname === "/api/rooms") {
    const body = await readJson(request);
    const room = createRoom(state, body);
    sendJson(response, 201, { room });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/observer/token") {
    const body = await readJson(request);
    const token = await issueObserverToken(state, body);
    sendJson(response, 200, token);
    return;
  }

  if (
    request.method === "POST" &&
    segments.length === 4 &&
    segments[0] === "api" &&
    segments[1] === "rooms" &&
    segments[3] === "tokens"
  ) {
    const roomId = segments[2];
    const body = await readJson(request);
    const token = await issueToken(state, roomId, body);
    sendJson(response, 200, token);
    return;
  }

  if (request.method === "GET" && segments[0] === "api" && segments[1] === "state") {
    sendJson(response, 200, snapshotState(state));
    return;
  }

  sendJson(response, 404, {
    error: "not-found",
    message: `${request.method} ${url.pathname} is not implemented`,
  });
}

function registerEndpoint(state, body) {
  const clientType = assertClientType(body.clientType);
  const now = new Date().toISOString();
  const endpoint = {
    id: body.id || `${clientType}-${randomUUID()}`,
    displayName: body.displayName || clientType,
    clientType,
    tags: Array.isArray(body.tags) ? body.tags : [],
    ipAddress: body.ipAddress,
    status: "online",
    appVersion: body.appVersion,
    createdAt: now,
    lastSeenAt: now,
  };
  state.endpoints.set(endpoint.id, endpoint);
  return endpoint;
}

function heartbeatEndpoint(state, body) {
  const endpointId = requiredString(body.endpointId, "endpointId");
  const endpoint = state.endpoints.get(endpointId);
  if (!endpoint) {
    throw new HttpError(404, "endpoint-not-found", "Endpoint is not registered");
  }
  endpoint.status = body.status || "online";
  endpoint.lastSeenAt = new Date().toISOString();
  return endpoint;
}

function createCall(state, body) {
  const requestedMode = assertRoomMode(body.requestedMode || body.mode || "watch");
  const callerEndpointId = requiredString(body.callerEndpointId, "callerEndpointId");
  const targetEndpointId = requiredString(body.targetEndpointId, "targetEndpointId");
  assertEndpointExists(state, callerEndpointId);
  assertEndpointExists(state, targetEndpointId);

  const now = new Date().toISOString();
  const call = {
    id: `call-${randomUUID()}`,
    callerEndpointId,
    targetEndpointId,
    requestedMode,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  state.calls.set(call.id, call);
  return call;
}

async function acceptCall(state, callId, body) {
  const call = getCall(state, callId);
  const acceptedMode = assertRoomMode(body.mode || call.requestedMode);
  const limits = {
    ...state.limits,
    ...(body.limits ?? {}),
  };

  const room = createRoom(state, {
    roomCode: body.roomCode,
    mode: acceptedMode,
    defaultChannelId: body.defaultChannelId,
    defaultTrackName: body.defaultTrackName,
    allowedChannelIds: body.allowedChannelIds,
    channels: body.channels,
    publishOtherChannelsOnDemand: body.publishOtherChannelsOnDemand,
    limits,
  });

  call.status = "accepted";
  call.acceptedMode = acceptedMode;
  call.roomId = room.roomId;
  call.mediaPolicy = room.mediaPolicy;
  call.updatedAt = new Date().toISOString();

  const hostToken = await issueToken(state, room.roomId, {
    clientType: "or-windows",
    role: "or-host",
    identity: body.hostIdentity || `${call.targetEndpointId}-host`,
  });

  return {
    call,
    room,
    hostToken,
  };
}

function createRoom(state, body) {
  const mode = assertRoomMode(body.mode || "watch");
  const roomId = body.roomId || `room-${randomUUID()}`;
  const roomCode = body.roomCode || `ST-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${String(state.rooms.size + 1).padStart(3, "0")}`;
  const now = new Date().toISOString();
  const mediaPolicy = buildAcceptedMediaPolicy(body, mode);
  const room = {
    roomId,
    roomCode,
    mode,
    mediaPolicy,
    limits: {
      ...state.limits,
      ...(body.limits ?? {}),
    },
    participantCounts: {
      interactive: 0,
      tablet: 0,
      webObserver: 0,
    },
    createdAt: now,
    updatedAt: now,
  };
  state.rooms.set(room.roomId, room);
  return room;
}

function buildAcceptedMediaPolicy(body, mode) {
  const providedChannels = normalizeVideoChannels(body.channels);
  const channels = providedChannels.length > 0 ? providedChannels : DEFAULT_VIDEO_CHANNELS;
  const requestedDefaultChannelId = optionalString(body.defaultChannelId);
  const explicitAllowedChannelIds = normalizeChannelIds(body.allowedChannelIds);
  const allowedChannelIds =
    explicitAllowedChannelIds.length > 0
      ? explicitAllowedChannelIds
      : inferAllowedChannelIds(channels, requestedDefaultChannelId);
  const selection = resolveDefaultChannel({
    allowedChannelIds,
    channels,
    providedChannels,
    requestedDefaultChannelId,
  });

  return {
    defaultChannelId: selection.channel?.id,
    defaultTrackName: selection.channel
      ? explicitTrackName(body.defaultTrackName) || trackNameFor(selection.channel)
      : undefined,
    defaultChannelDisplayName: selection.channel?.displayName,
    defaultSelectionReason: selection.reason,
    startupVideoMode: selection.channel ? "default-video" : "audio-only",
    mode,
    allowedChannelIds,
    publishOtherChannelsOnDemand: body.publishOtherChannelsOnDemand ?? true,
  };
}

function resolveDefaultChannel({
  allowedChannelIds,
  channels,
  providedChannels,
  requestedDefaultChannelId,
}) {
  const allowed = new Set(allowedChannelIds);

  if (requestedDefaultChannelId) {
    if (!allowed.has(requestedDefaultChannelId)) {
      throw new HttpError(
        400,
        "invalid-default-channel",
        "defaultChannelId must be included in allowedChannelIds",
      );
    }

    const channel = channels.find((candidate) => candidate.id === requestedDefaultChannelId);
    if (providedChannels.length > 0 && !channel) {
      throw new HttpError(
        400,
        "invalid-default-channel",
        "defaultChannelId must exist in the accepted channel list",
      );
    }
    if (channel && !isSelectableChannel(channel)) {
      throw new HttpError(
        409,
        "unavailable-default-channel",
        "defaultChannelId is disabled or offline",
      );
    }

    return {
      channel: channel ?? virtualChannel(requestedDefaultChannelId),
      reason: "manual-accept",
    };
  }

  const candidates = channels.filter(
    (channel) => allowed.has(channel.id) && isSelectableChannel(channel),
  );
  const localPrimary = pickHighestPriority(candidates.filter((channel) => channel.localPrimary));
  if (localPrimary) {
    return { channel: localPrimary, reason: "local-primary" };
  }

  const remoteDefault = pickHighestPriority(candidates.filter((channel) => channel.remoteDefault));
  if (remoteDefault) {
    return { channel: remoteDefault, reason: "remote-default" };
  }

  const priorityDefault = pickHighestPriority(candidates);
  if (priorityDefault) {
    return { channel: priorityDefault, reason: "priority" };
  }

  return { channel: undefined, reason: "audio-only" };
}

function normalizeVideoChannels(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((channel) => {
      if (!channel || typeof channel !== "object") return undefined;
      const id = optionalString(channel.id);
      if (!id) return undefined;
      return {
        id,
        displayName: optionalString(channel.displayName) || id,
        enabled: channel.enabled !== false,
        health: optionalString(channel.health) || (channel.healthy === false ? "offline" : "healthy"),
        localPrimary: channel.localPrimary === true,
        remoteDefault: channel.remoteDefault === true,
        priority: Number.isFinite(Number(channel.priority)) ? Number(channel.priority) : 1000,
        trackName: explicitTrackName(channel.trackName),
      };
    })
    .filter(Boolean);
}

function normalizeChannelIds(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const channelIds = [];
  for (const item of value) {
    const channelId = optionalString(item);
    if (channelId && !seen.has(channelId)) {
      seen.add(channelId);
      channelIds.push(channelId);
    }
  }
  return channelIds;
}

function inferAllowedChannelIds(channels, requestedDefaultChannelId) {
  const allowedChannelIds = channels
    .filter((channel) => channel.enabled !== false)
    .map((channel) => channel.id);
  if (requestedDefaultChannelId && !allowedChannelIds.includes(requestedDefaultChannelId)) {
    allowedChannelIds.unshift(requestedDefaultChannelId);
  }
  return allowedChannelIds;
}

function isSelectableChannel(channel) {
  return channel.enabled !== false && channel.health !== "offline" && channel.health !== "error";
}

function pickHighestPriority(channels) {
  return [...channels].sort((left, right) => left.priority - right.priority)[0];
}

function trackNameFor(channel) {
  return channel.trackName || `video:${channel.id}`;
}

function virtualChannel(channelId) {
  return {
    id: channelId,
    displayName: channelId,
    enabled: true,
    health: "unknown",
    localPrimary: false,
    remoteDefault: false,
    priority: 1000,
    trackName: `video:${channelId}`,
  };
}

async function issueToken(state, roomId, body) {
  const room = state.rooms.get(roomId);
  if (!room) {
    throw new HttpError(404, "room-not-found", "Room does not exist");
  }

  const clientType = assertClientType(body.clientType);
  const role = body.role || defaultRoleForClientType(clientType, body.mode);
  enforceParticipantLimit(room, clientType, body.mode);

  const grants = grantsFor(clientType, body.mode);
  const identity = body.identity || `${clientType}-${randomUUID()}`;
  const metadata = {
    clientType,
    mode: clientType === "web-observer" ? "watch-only" : body.mode || room.mode,
    role,
    roomCode: room.roomCode,
    defaultChannelId: room.mediaPolicy.defaultChannelId,
    defaultTrackName: room.mediaPolicy.defaultTrackName,
    startupVideoMode: room.mediaPolicy.startupVideoMode,
  };
  const tokenPayload = {
    type: `${state.tokenConfig.mode}-livekit-token`,
    roomName: room.roomId,
    roomCode: room.roomCode,
    identity,
    clientType,
    role,
    grants,
    metadata,
    issuedAt: new Date().toISOString(),
  };

  const token =
    state.tokenConfig.mode === "real"
      ? await issueRealLiveKitJwt(state.tokenConfig, room.roomId, identity, grants, metadata)
      : `mock.${Buffer.from(JSON.stringify(tokenPayload)).toString("base64url")}`;
  state.issuedTokens.push(tokenPayload);
  incrementParticipantCount(room, clientType, body.mode);

  return {
    token,
    tokenType: state.tokenConfig.mode,
    livekitUrl: state.tokenConfig.livekitUrl,
    room,
    grants,
    metadata,
  };
}

async function issueObserverToken(state, body) {
  const roomCode = requiredString(body.roomCode, "roomCode");
  const room = [...state.rooms.values()].find(
    (candidate) => candidate.roomCode === roomCode || candidate.roomId === roomCode,
  );

  if (!room) {
    throw new HttpError(404, "room-not-found", "Room code does not exist");
  }

  return issueToken(state, room.roomId, {
    clientType: "web-observer",
    role: "web-observer",
    mode: "watch",
    identity: body.identity,
  });
}

async function issueRealLiveKitJwt(tokenConfig, roomName, identity, grants, metadata) {
  if (!tokenConfig.apiKey || !tokenConfig.apiSecret) {
    throw new HttpError(
      500,
      "livekit-credentials-missing",
      "LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required for real token mode",
    );
  }

  const token = new AccessToken(tokenConfig.apiKey, tokenConfig.apiSecret, {
    identity,
    ttl: tokenConfig.ttlSeconds,
  });
  token.metadata = JSON.stringify(metadata);
  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: grants.canPublish,
    canSubscribe: grants.canSubscribe,
    canPublishData: grants.canPublishData,
  });
  return token.toJwt();
}

function grantsFor(clientType, mode) {
  if (clientType === "web-observer") {
    return {
      roomJoin: true,
      canSubscribe: true,
      canPublish: false,
      canPublishData: false,
    };
  }

  if (mode === "watch") {
    return {
      roomJoin: true,
      canSubscribe: true,
      canPublish: false,
      canPublishData: true,
    };
  }

  return {
    roomJoin: true,
    canSubscribe: true,
    canPublish: true,
    canPublishData: true,
  };
}

function enforceParticipantLimit(room, clientType, mode) {
  if (clientType === "web-observer") {
    if (room.participantCounts.webObserver >= room.limits.maxWebObservers) {
      throw new HttpError(409, "web-observer-limit", "Phone observer limit reached");
    }
    return;
  }

  if (clientType === "tablet-client") {
    if (room.participantCounts.tablet >= room.limits.maxTabletClients) {
      throw new HttpError(409, "tablet-limit", "Tablet client limit reached");
    }
  }

  if (mode !== "watch" && clientType !== "web-observer") {
    if (room.participantCounts.interactive >= room.limits.maxInteractiveParticipants) {
      throw new HttpError(409, "interactive-limit", "Interactive participant limit reached");
    }
  }
}

function incrementParticipantCount(room, clientType, mode) {
  if (clientType === "web-observer") {
    room.participantCounts.webObserver += 1;
  }
  if (clientType === "tablet-client") {
    room.participantCounts.tablet += 1;
  }
  if (mode !== "watch" && clientType !== "web-observer") {
    room.participantCounts.interactive += 1;
  }
  room.updatedAt = new Date().toISOString();
}

function defaultRoleForClientType(clientType, mode) {
  if (clientType === "or-windows") return "or-host";
  if (clientType === "tablet-client") return "tablet";
  if (clientType === "web-observer") return "web-observer";
  return mode === "watch" ? "teacher-watch" : "teacher-interactive";
}

function updateCallStatus(state, callId, status) {
  const call = getCall(state, callId);
  call.status = status;
  call.updatedAt = new Date().toISOString();
  return call;
}

function getCall(state, callId) {
  const call = state.calls.get(callId);
  if (!call) {
    throw new HttpError(404, "call-not-found", "Call does not exist");
  }
  return call;
}

function assertEndpointExists(state, endpointId) {
  if (!state.endpoints.has(endpointId)) {
    throw new HttpError(404, "endpoint-not-found", `Endpoint ${endpointId} is not registered`);
  }
}

function assertClientType(clientType) {
  if (!VALID_CLIENT_TYPES.has(clientType)) {
    throw new HttpError(400, "invalid-client-type", `Invalid clientType: ${clientType}`);
  }
  return clientType;
}

function assertRoomMode(mode) {
  if (!VALID_ROOM_MODES.has(mode)) {
    throw new HttpError(400, "invalid-room-mode", `Invalid room mode: ${mode}`);
  }
  return mode;
}

function requiredString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, "missing-field", `${fieldName} is required`);
  }
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function explicitTrackName(value) {
  const trackName = optionalString(value);
  return trackName || undefined;
}

function snapshotState(state) {
  return {
    endpoints: [...state.endpoints.values()],
    calls: [...state.calls.values()],
    rooms: [...state.rooms.values()],
    issuedTokens: state.issuedTokens.map((token) => ({
      identity: token.identity,
      clientType: token.clientType,
      grants: token.grants,
      metadata: token.metadata,
    })),
    limits: state.limits,
    tokenMode: state.tokenConfig.mode,
    livekitUrl: state.tokenConfig.livekitUrl,
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid-json", "Request body is not valid JSON");
  }
}

function sendJson(response, statusCode, payload) {
  setCorsHeaders(response);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload, null, 2));
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

class HttpError extends Error {
  constructor(statusCode, error, message) {
    super(message);
    this.statusCode = statusCode;
    this.error = error;
  }
}

process.on("uncaughtException", (error) => {
  console.error(error);
  process.exitCode = 1;
});

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const port = Number.parseInt(process.env.SMARTST_POC_PORT ?? "4780", 10);
  const host = process.env.SMARTST_POC_HOST ?? "127.0.0.1";
  const { server } = createBusinessServiceServer();
  server.listen(port, host, () => {
    console.log(`SmartST business service PoC listening at http://${host}:${port}`);
  });
}
