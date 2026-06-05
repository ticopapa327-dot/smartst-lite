import readline from "node:readline";

const PROCESS_ID = `media-worker-${process.pid}`;

const MOCK_DEVICES = Object.freeze({
  video: [
    {
      deviceId: "mock-video-panorama",
      displayName: "Mock USB Capture - Panorama",
      transport: "usb",
      role: "panorama",
      capabilities: [{ width: 1920, height: 1080, frameRate: 30 }],
    },
    {
      deviceId: "mock-video-field",
      displayName: "Mock USB Capture - Surgical Field",
      transport: "usb",
      role: "field",
      capabilities: [{ width: 1920, height: 1080, frameRate: 30 }],
    },
    {
      deviceId: "mock-video-endoscope",
      displayName: "Mock USB Capture - Endoscope",
      transport: "usb",
      role: "endoscope",
      capabilities: [{ width: 1920, height: 1080, frameRate: 30 }],
    },
    {
      deviceId: "mock-video-device",
      displayName: "Mock USB Capture - Medical Device",
      transport: "usb",
      role: "device",
      capabilities: [{ width: 1920, height: 1080, frameRate: 30 }],
    },
  ],
  audio: [
    {
      deviceId: "mock-audio-room",
      displayName: "Mock USB Omnidirectional Microphone",
      transport: "usb",
      role: "room-microphone",
      capabilities: [{ sampleRate: 48000, channels: 2 }],
    },
  ],
});

const DEFAULT_CHANNELS = ["panorama", "field-camera", "endoscope", "aux-device"];

const state = {
  processId: PROCESS_ID,
  workerVersion: "poc-0.1",
  state: "idle",
  startedAt: undefined,
  stoppedAt: undefined,
  channels: [],
  recording: {
    state: "idle",
    activeChannelIds: [],
  },
  livekit: {
    state: "idle",
    roomName: undefined,
    livekitUrl: undefined,
    publisherKind: undefined,
    realPublisher: false,
    requiresNativeSdk: true,
    startedAt: undefined,
    publishedTrackNames: [],
  },
  stats: {
    uptimeMs: 0,
    framesProduced: 0,
    audioPacketsProduced: 0,
    syntheticFramesProduced: 0,
  },
  lastError: undefined,
};

let statsTimer = null;

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

emitEvent("worker", "ready", snapshot());

rl.on("line", async (line) => {
  if (!line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    emitEvent("error", "invalid-json", { line });
    return;
  }

  try {
    const result = await handleCommand(message);
    sendResponse(message.id, true, result);
  } catch (error) {
    const payload = {
      code: error.code || "worker-error",
      message: error instanceof Error ? error.message : "Unknown worker error",
    };
    state.lastError = payload;
    emitEvent("error", payload.code, payload);
    sendResponse(message.id, false, payload);
  }
});

rl.on("close", () => {
  cleanup();
});

async function handleCommand(message) {
  const method = requiredString(message.method, "method");
  const params = message.params ?? {};

  switch (method) {
    case "listDevices":
      emitEvent("device", "snapshot", MOCK_DEVICES);
      return MOCK_DEVICES;
    case "start":
      return startWorker(params);
    case "stop":
      return stopWorker();
    case "status":
      return snapshot();
    case "startSyntheticPublisher":
      return startSyntheticPublisher(params);
    case "stopSyntheticPublisher":
      return stopSyntheticPublisher();
    case "shutdown":
      cleanup();
      setTimeout(() => process.exit(0), 0);
      return { shuttingDown: true };
    default:
      throw new WorkerError("unknown-method", `Unknown method: ${method}`);
  }
}

function startWorker(params) {
  if (state.state === "running") {
    emitEvent("worker", "already-running", snapshot());
    return snapshot();
  }

  const requestedChannels = Array.isArray(params.channels) && params.channels.length > 0
    ? params.channels
    : DEFAULT_CHANNELS;

  state.state = "running";
  state.startedAt = new Date().toISOString();
  state.stoppedAt = undefined;
  state.channels = requestedChannels.map((channelId, index) => ({
    channelId,
    state: "previewing",
    source: "mock",
    trackName: `video:${channelId}`,
    width: 1920,
    height: 1080,
    frameRate: 30,
    priority: index + 1,
  }));
  state.recording = {
    state: "idle",
    activeChannelIds: [],
  };
  state.livekit = {
    state: "idle",
    roomName: undefined,
    livekitUrl: undefined,
    publisherKind: undefined,
    realPublisher: false,
    requiresNativeSdk: true,
    startedAt: undefined,
    publishedTrackNames: [],
  };
  state.stats = {
    uptimeMs: 0,
    framesProduced: 0,
    audioPacketsProduced: 0,
    syntheticFramesProduced: 0,
  };

  emitEvent("device", "snapshot", MOCK_DEVICES);
  for (const channel of state.channels) {
    emitEvent("channel", "started", channel);
  }
  emitEvent("recording", "state", state.recording);
  emitEvent("livekit", "state", state.livekit);
  startStatsTimer();
  return snapshot();
}

function stopWorker() {
  if (state.state === "idle") {
    emitEvent("worker", "already-idle", snapshot());
    return snapshot();
  }

  clearStatsTimer();
  for (const channel of state.channels) {
    emitEvent("channel", "stopped", {
      channelId: channel.channelId,
      state: "stopped",
    });
  }
  state.state = "idle";
  state.stoppedAt = new Date().toISOString();
  state.channels = [];
  state.recording = {
    state: "idle",
    activeChannelIds: [],
  };
  state.livekit = {
    state: "idle",
    roomName: undefined,
    livekitUrl: undefined,
    publisherKind: undefined,
    realPublisher: false,
    requiresNativeSdk: true,
    startedAt: undefined,
    publishedTrackNames: [],
  };
  emitEvent("worker", "stopped", snapshot());
  return snapshot();
}

function startSyntheticPublisher(params) {
  if (state.state !== "running") {
    throw new WorkerError("worker-not-running", "Worker must be running before synthetic publishing");
  }

  const roomName = requiredString(params.roomName, "roomName");
  const trackNames = Array.isArray(params.trackNames) && params.trackNames.length > 0
    ? params.trackNames.map((trackName) => requiredString(trackName, "trackName"))
    : state.channels.map((channel) => channel.trackName);

  state.livekit = {
    state: "mock-publishing",
    roomName,
    livekitUrl: typeof params.livekitUrl === "string" ? params.livekitUrl : undefined,
    publisherKind: "synthetic-mock",
    realPublisher: false,
    requiresNativeSdk: true,
    startedAt: new Date().toISOString(),
    publishedTrackNames: trackNames,
  };

  emitEvent("livekit", "publisher-started", state.livekit);
  return snapshot();
}

function stopSyntheticPublisher() {
  if (state.livekit.state === "idle") {
    emitEvent("livekit", "publisher-already-idle", state.livekit);
    return snapshot();
  }

  state.livekit = {
    state: "idle",
    roomName: undefined,
    livekitUrl: undefined,
    publisherKind: undefined,
    realPublisher: false,
    requiresNativeSdk: true,
    startedAt: undefined,
    publishedTrackNames: [],
  };
  emitEvent("livekit", "publisher-stopped", state.livekit);
  return snapshot();
}

function startStatsTimer() {
  clearStatsTimer();
  statsTimer = setInterval(() => {
    if (state.state !== "running") return;
    const started = Date.parse(state.startedAt);
    state.stats.uptimeMs = Number.isFinite(started) ? Date.now() - started : 0;
    state.stats.framesProduced += state.channels.length * 30;
    state.stats.audioPacketsProduced += 50;
    if (state.livekit.state === "mock-publishing") {
      state.stats.syntheticFramesProduced += state.livekit.publishedTrackNames.length * 30;
    }
    emitEvent("stats", "tick", state.stats);
  }, 1000);
}

function clearStatsTimer() {
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
}

function cleanup() {
  clearStatsTimer();
}

function snapshot() {
  return {
    processId: state.processId,
    workerVersion: state.workerVersion,
    state: state.state,
    startedAt: state.startedAt,
    stoppedAt: state.stoppedAt,
    channels: state.channels,
    recording: state.recording,
    livekit: state.livekit,
    stats: state.stats,
    lastError: state.lastError,
  };
}

function requiredString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WorkerError("missing-field", `${fieldName} is required`);
  }
  return value.trim();
}

function sendResponse(id, ok, payload) {
  writeJson({
    type: "response",
    id,
    ok,
    [ok ? "result" : "error"]: payload,
  });
}

function emitEvent(category, name, payload) {
  writeJson({
    type: "event",
    event: {
      category,
      name,
      payload,
      time: new Date().toISOString(),
    },
  });
}

function writeJson(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

class WorkerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
