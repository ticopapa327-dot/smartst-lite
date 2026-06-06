import { createBusinessServiceServer } from "./server.mjs";

const { server } = createBusinessServiceServer({
  tokenMode: "real",
  livekitUrl: "ws://127.0.0.1:7880",
  livekitApiKey: "dev-api-key",
  livekitApiSecret: "dev-api-secret-for-local-signing-only",
  livekitTokenTtlSeconds: 900,
  limits: {
    maxInteractiveParticipants: 2,
    maxTabletClients: 1,
    maxWebObservers: 1,
  },
});

const baseUrl = await listenOnRandomPort(server);

try {
  const roomResponse = await post(
    "/api/rooms",
    {
      roomCode: "ST-JWT-001",
      mode: "watch",
      defaultChannelId: "field-camera",
      limits: {
        maxWebObservers: 1,
      },
    },
    201,
  );

  const hostToken = await post(`/api/rooms/${roomResponse.room.roomId}/tokens`, {
    clientType: "or-windows",
    identity: "or-real-token-smoke",
    mode: "interactive",
  });

  const observerToken = await post("/api/observer/token", {
    roomCode: "ST-JWT-001",
    identity: "phone-real-token-smoke",
  });

  assert(hostToken.tokenType === "real", "host token is real JWT mode");
  assert(observerToken.tokenType === "real", "observer token is real JWT mode");
  assert(!hostToken.token.startsWith("mock."), "host token is not mock");
  assert(!observerToken.token.startsWith("mock."), "observer token is not mock");

  const hostPayload = decodeJwtPayload(hostToken.token);
  const observerPayload = decodeJwtPayload(observerToken.token);

  assert(hostPayload.iss === "dev-api-key", "JWT issuer is API key");
  assert(hostPayload.sub === "or-real-token-smoke", "host identity is subject");
  assert(hostPayload.video.room === roomResponse.room.roomId, "host room matches");
  assert(hostPayload.video.roomJoin === true, "host can join");
  assert(hostPayload.video.canPublish === true, "host can publish");
  assert(hostPayload.video.canSubscribe === true, "host can subscribe");
  assert(hostPayload.video.canPublishData === true, "host can publish data");

  assert(observerPayload.sub === "phone-real-token-smoke", "observer identity is subject");
  assert(observerPayload.video.roomJoin === true, "observer can join");
  assert(observerPayload.video.canPublish === false, "observer cannot publish");
  assert(observerPayload.video.canSubscribe === true, "observer can subscribe");
  assert(observerPayload.video.canPublishData === false, "observer cannot publish data");
  assert(JSON.parse(observerPayload.metadata).mode === "watch-only", "observer metadata is watch-only");
  assert(hostToken.metadata.defaultChannelId === "field-camera", "host token response has default channel");
  assert(hostToken.metadata.defaultTrackName === "video:field-camera", "host token response has default track");
  assert(observerToken.metadata.defaultChannelId === "field-camera", "observer token response has default channel");
  assert(JSON.parse(hostPayload.metadata).defaultChannelId === "field-camera", "host JWT metadata has default channel");
  assert(JSON.parse(hostPayload.metadata).startupVideoMode === "default-video", "host JWT metadata has startup video mode");
  assert(JSON.parse(observerPayload.metadata).defaultTrackName === "video:field-camera", "observer JWT metadata has default track");

  console.log("server-poc real token smoke passed");
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

function decodeJwtPayload(token) {
  const parts = token.split(".");
  assert(parts.length === 3, "JWT has three parts");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
