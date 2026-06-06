import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const configFiles = [
  "deploy/config/ust-server.example.json",
  "deploy/config/ust-or-agent.example.json",
  "deploy/config/ust-desktop-client.example.json",
];

const forbiddenClientKeys = [
  "LIVEKIT_API_SECRET",
  "apiSecret",
  "apiSecretEnv",
  "hisPassword",
  "ftpPassword",
  "sftpPassword",
  "patientFullName",
  "patientIdCard",
];

try {
  const configs = {};
  for (const file of configFiles) {
    configs[file] = await readConfig(file);
  }

  const serverConfig = configs["deploy/config/ust-server.example.json"];
  const orAgentConfig = configs["deploy/config/ust-or-agent.example.json"];
  const desktopConfig = configs["deploy/config/ust-desktop-client.example.json"];

  assert(serverConfig.role === "UST Server", "server role mismatch");
  assert(serverConfig.livekit.apiSecretEnv === "LIVEKIT_API_SECRET", "server must reference secret by env name");
  assert(!JSON.stringify(serverConfig).includes("dev-api-secret"), "server config contains a dev secret");
  assert(serverConfig.listen.businessPort === 4780, "server business port must default to 4780");
  assert(serverConfig.livekit.udpMuxPort === 7882, "LiveKit UDP mux port must default to 7882");
  assert(serverConfig.observerPolicy.allowPublishAudio === false, "phone observers must not publish audio");
  assert(serverConfig.observerPolicy.allowPublishVideo === false, "phone observers must not publish video");
  assert(serverConfig.observerPolicy.allowPublishData === false, "phone observers must not publish data");

  assert(orAgentConfig.role === "UST OR Agent", "OR Agent role mismatch");
  assert(orAgentConfig.controlApi.port === 4781, "OR Agent control port must default to 4781");
  assert(orAgentConfig.nativeWorker.videoPayloadQueueCapacity > 0, "video payload queue capacity missing");
  assert(orAgentConfig.channels.some((channel) => channel.id === "field-camera" && channel.remoteDefault), "field-camera must be remote default");
  assertNoForbiddenSecrets(orAgentConfig, forbiddenClientKeys, "OR Agent config");

  assert(desktopConfig.role === "UST Desktop Client", "Desktop Client role mismatch");
  assert(desktopConfig.livekit.storeApiSecret === false, "Desktop Client must not store API secret");
  assertNoForbiddenSecrets(desktopConfig, forbiddenClientKeys, "Desktop Client config");

  console.log(JSON.stringify({
    status: "passed",
    schemaVersion: "ust.service-config-preflight.v0.1",
    configs: Object.fromEntries(
      Object.entries(configs).map(([file, config]) => [
        file,
        {
          role: config.role,
          schemaVersion: config.schemaVersion,
        },
      ]),
    ),
    ports: {
      businessServiceTcp: serverConfig.listen.businessPort,
      orAgentControlTcp: orAgentConfig.controlApi.port,
      livekitHttpTcp: 7880,
      livekitIceTcp: serverConfig.livekit.iceTcpPort,
      livekitIceUdp: serverConfig.livekit.udpMuxPort,
      webObserverTcp: 5175,
    },
    boundaries: {
      serverOnlySecretEnv: serverConfig.livekit.apiSecretEnv,
      orAgentStoresLiveKitSecret: false,
      desktopStoresLiveKitSecret: false,
      phoneObserverPublishAllowed: false,
    },
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({
    status: "failed",
    schemaVersion: "ust.service-config-preflight.v0.1",
    error: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
}

async function readConfig(file) {
  return JSON.parse(await readFile(resolve(repoRoot, file), "utf8"));
}

function assertNoForbiddenSecrets(config, keys, label) {
  const text = JSON.stringify(config);
  for (const key of keys) {
    assert(!text.includes(key), `${label} contains forbidden secret marker: ${key}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
