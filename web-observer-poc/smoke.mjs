import { readFile } from "node:fs/promises";
import { createBusinessServiceServer } from "../server-poc/server.mjs";

const source = await readFile(new URL("./src/main.ts", import.meta.url), "utf8");

for (const forbidden of [
  "setCameraEnabled",
  "setMicrophoneEnabled",
  "createLocalTracks",
  "publishTrack",
  "publishData",
  "getUserMedia",
  "getDisplayMedia",
  "navigator.mediaDevices",
]) {
  assert(!source.includes(forbidden), `web observer source must not include ${forbidden}`);
}

const { server } = createBusinessServiceServer({
  limits: {
    maxInteractiveParticipants: 2,
    maxTabletClients: 1,
    maxWebObservers: 1,
  },
});

const baseUrl = await listenOnRandomPort(server);

try {
  await post(
    "/api/rooms",
    {
      roomCode: "ST-OBS-001",
      mode: "watch",
      defaultChannelId: "field-camera",
      limits: {
        maxWebObservers: 1,
      },
    },
    201,
  );

  const token = await post("/api/observer/token", {
    roomCode: "ST-OBS-001",
    identity: "phone-observer-001",
  });

  const denied = await post(
    "/api/observer/token",
    {
      roomCode: "ST-OBS-001",
      identity: "phone-observer-002",
    },
    409,
  );

  assert(token.grants.roomJoin === true, "observer can join room");
  assert(token.grants.canSubscribe === true, "observer can subscribe");
  assert(token.grants.canPublish === false, "observer cannot publish media");
  assert(token.grants.canPublishData === false, "observer cannot publish data");
  assert(token.room.mediaPolicy.defaultTrackName === "video:field-camera", "default track is exposed");
  assert(denied.error === "web-observer-limit", "observer limit is enforced");

  console.log("web-observer-poc smoke passed");
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
