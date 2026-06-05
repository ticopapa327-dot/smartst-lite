import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(rootDir, "native-worker/Cargo.toml");
const child = spawn("cargo", ["run", "--quiet", "--manifest-path", manifestPath], {
  cwd: rootDir,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let stdoutBuffer = "";
let stderr = "";
let completed = false;

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  let newlineIndex = stdoutBuffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = stdoutBuffer.slice(0, newlineIndex);
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    handleLine(line);
    newlineIndex = stdoutBuffer.indexOf("\n");
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

child.on("close", (exitCode) => {
  if (!completed) {
    console.error(stderr || `native worker exited before listDevices completed. exit=${exitCode}`);
    process.exit(exitCode || 1);
  }
});

setTimeout(() => {
  if (!completed) {
    child.kill();
    console.error(`native worker listDevices timed out. stderr=${stderr}`);
    process.exit(1);
  }
}, 20000).unref();

function handleLine(line) {
  if (!line.trim()) return;
  const message = JSON.parse(line);

  if (message.type === "event" && message.event?.category === "worker" && message.event?.name === "ready") {
    child.stdin.write(`${JSON.stringify({ id: "list-devices", method: "listDevices" })}\n`);
    return;
  }

  if (message.type === "response" && message.id === "list-devices") {
    if (!message.ok) {
      completed = true;
      console.error(JSON.stringify(message.error, null, 2));
      child.kill();
      process.exit(1);
    }
    console.log(JSON.stringify(message.result, null, 2));
    completed = true;
    child.stdin.write(`${JSON.stringify({ id: "shutdown", method: "shutdown" })}\n`);
    child.kill();
  }
}
