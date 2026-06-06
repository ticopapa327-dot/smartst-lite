import { createBusinessServiceServer } from "./server.mjs";

const { server } = createBusinessServiceServer({
  limits: {
    maxInteractiveParticipants: 2,
    maxTabletClients: 1,
    maxWebObservers: 2,
  },
});

const baseUrl = await listenOnRandomPort(server);

try {
  const orEndpoint = await post("/api/endpoints/register", {
    id: "or-01",
    displayName: "OR-01",
    clientType: "or-windows",
    tags: ["or"],
  });

  const teachingEndpoint = await post("/api/endpoints/register", {
    id: "teach-01",
    displayName: "Teaching Room",
    clientType: "teaching-windows",
  });

  const callResponse = await post("/api/calls", {
    callerEndpointId: teachingEndpoint.endpoint.id,
    targetEndpointId: orEndpoint.endpoint.id,
    requestedMode: "interactive",
  }, 201);

  const acceptResponse = await post(`/api/calls/${callResponse.call.id}/accept`, {
    mode: "interactive",
    defaultChannelId: "field-camera",
    channels: [
      {
        id: "panorama",
        displayName: "Panorama",
        enabled: true,
        healthy: true,
        localPrimary: false,
        remoteDefault: false,
        priority: 20,
      },
      {
        id: "field-camera",
        displayName: "Field Camera",
        enabled: true,
        healthy: true,
        localPrimary: true,
        remoteDefault: true,
        priority: 10,
      },
    ],
    limits: {
      maxInteractiveParticipants: 2,
      maxTabletClients: 1,
      maxWebObservers: 2,
    },
  });

  const watchToken = await post("/api/observer/token", {
    roomCode: acceptResponse.room.roomCode,
    identity: "web-observer-001",
  });

  const secondWatchToken = await post("/api/observer/token", {
    roomCode: acceptResponse.room.roomCode,
    identity: "web-observer-002",
  });

  const limitResult = await post(
    "/api/observer/token",
    {
      roomCode: acceptResponse.room.roomCode,
      identity: "web-observer-003",
    },
    409,
  );

  assert(watchToken.grants.canSubscribe === true, "web observer can subscribe");
  assert(watchToken.grants.canPublish === false, "web observer cannot publish");
  assert(watchToken.grants.canPublishData === false, "web observer cannot publish data");
  assert(acceptResponse.room.mediaPolicy.defaultChannelId === "field-camera", "accept default channel is explicit");
  assert(acceptResponse.room.mediaPolicy.defaultTrackName === "video:field-camera", "accept default track name is derived");
  assert(acceptResponse.room.mediaPolicy.defaultSelectionReason === "manual-accept", "accept reason is explicit");
  assert(acceptResponse.room.mediaPolicy.startupVideoMode === "default-video", "accept starts with one default video");
  assert(watchToken.room.mediaPolicy.defaultChannelId === "field-camera", "observer token includes room default channel");
  assert(watchToken.room.mediaPolicy.startupVideoMode === "default-video", "observer token includes startup video mode");
  assert(watchToken.metadata.defaultChannelId === "field-camera", "observer metadata includes default channel");
  assert(watchToken.metadata.defaultTrackName === "video:field-camera", "observer metadata includes default track");
  assert(secondWatchToken.tokenType === "mock", "second observer token issued");
  assert(limitResult.error === "web-observer-limit", "observer limit enforced");

  const localPrimaryRoom = await post(
    "/api/rooms",
    {
      roomCode: "ST-DEFAULT-LOCAL",
      mode: "watch",
      channels: [
        {
          id: "panorama",
          displayName: "Panorama",
          enabled: true,
          health: "healthy",
          localPrimary: false,
          remoteDefault: true,
          priority: 10,
        },
        {
          id: "field-camera",
          displayName: "Field Camera",
          enabled: true,
          health: "healthy",
          localPrimary: true,
          remoteDefault: false,
          priority: 50,
        },
      ],
    },
    201,
  );
  assert(localPrimaryRoom.room.mediaPolicy.defaultChannelId === "field-camera", "local primary wins before remote default");
  assert(localPrimaryRoom.room.mediaPolicy.defaultSelectionReason === "local-primary", "local primary reason");

  const priorityRoom = await post(
    "/api/rooms",
    {
      roomCode: "ST-DEFAULT-PRIORITY",
      mode: "watch",
      channels: [
        {
          id: "endoscope",
          displayName: "Endoscope",
          enabled: true,
          health: "healthy",
          localPrimary: false,
          remoteDefault: false,
          priority: 30,
        },
        {
          id: "panorama",
          displayName: "Panorama",
          enabled: true,
          health: "healthy",
          localPrimary: false,
          remoteDefault: false,
          priority: 20,
        },
      ],
    },
    201,
  );
  assert(priorityRoom.room.mediaPolicy.defaultChannelId === "panorama", "priority fallback picks lowest priority");
  assert(priorityRoom.room.mediaPolicy.defaultSelectionReason === "priority", "priority reason");

  const audioOnlyRoom = await post(
    "/api/rooms",
    {
      roomCode: "ST-DEFAULT-AUDIO",
      mode: "interactive",
      channels: [
        {
          id: "field-camera",
          displayName: "Field Camera",
          enabled: true,
          healthy: false,
          localPrimary: true,
          remoteDefault: true,
          priority: 10,
        },
      ],
    },
    201,
  );
  assert(audioOnlyRoom.room.mediaPolicy.defaultChannelId === undefined, "audio-only has no default video channel");
  assert(audioOnlyRoom.room.mediaPolicy.defaultSelectionReason === "audio-only", "audio-only reason");
  assert(audioOnlyRoom.room.mediaPolicy.startupVideoMode === "audio-only", "audio-only startup mode");

  const invalidDefault = await post(
    "/api/rooms",
    {
      roomCode: "ST-DEFAULT-INVALID",
      mode: "watch",
      defaultChannelId: "field-camera",
      allowedChannelIds: ["panorama"],
    },
    400,
  );
  assert(invalidDefault.error === "invalid-default-channel", "invalid default is rejected");

  console.log("server-poc smoke passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
}

async function listenOnRandomPort(serverInstance) {
  await new Promise((resolve) => {
    serverInstance.listen(0, "127.0.0.1", resolve);
  });
  const address = serverInstance.address();
  return `http://127.0.0.1:${address.port}`;
}

async function post(path, body, expectedStatus = 200) {
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
