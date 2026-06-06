import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const preflightPath = join(scriptDir, "livekit-preflight.mjs");
const env = { ...process.env };

delete env.LIVEKIT_URL;
delete env.LIVEKIT_API_KEY;
delete env.LIVEKIT_API_SECRET;

const result = await run(process.execPath, [preflightPath], env);

assert(result.exitCode === 2, `missing-env preflight should exit 2, got ${result.exitCode}`);

const payload = JSON.parse(result.stdout.trim());
assert(payload.status === "blocked", "missing-env preflight should return blocked");
assert(payload.error === "missing-livekit-env", "missing-env preflight should report missing-livekit-env");
assert(payload.missingEnv.includes("LIVEKIT_URL"), "missing-env preflight should require LIVEKIT_URL");
assert(payload.missingEnv.includes("LIVEKIT_API_KEY"), "missing-env preflight should require LIVEKIT_API_KEY");
assert(payload.missingEnv.includes("LIVEKIT_API_SECRET"), "missing-env preflight should require LIVEKIT_API_SECRET");

console.log("server-poc livekit preflight smoke passed");

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      cwd: join(scriptDir, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 0,
        stdout,
        stderr,
      });
    });
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
