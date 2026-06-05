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
  assert(secondWatchToken.tokenType === "mock", "second observer token issued");
  assert(limitResult.error === "web-observer-limit", "observer limit enforced");

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
