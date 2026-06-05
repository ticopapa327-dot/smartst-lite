import { spawn } from "node:child_process";

const npmCliPath = process.env.npm_execpath;

const checks = [
  ["run", "build"],
  ["run", "web-observer:poc:build"],
  ["run", "server:poc:smoke"],
  ["run", "server:poc:real-token-smoke"],
  ["run", "web-observer:poc:smoke"],
  ["run", "media-worker:poc:smoke"],
  ["run", "media-worker:native:smoke"],
  ["run", "media-worker:native:payload-consume"],
  ["run", "media-worker:native:video-pgm-export"],
  ["run", "media-worker:native:audio-payload-consume"],
  ["run", "media-worker:native:audio-wav-export"],
  ["run", "media-worker:native:audio-profile"],
  ["run", "media-worker:native:session-backpressure"],
  ["run", "media-worker:native-readiness:smoke"],
  ["run", "media-worker:device-probe:smoke"],
  ["run", "media-worker:usb4-validate:smoke"],
  ["run", "recording:poc:smoke"],
];

const startedAt = Date.now();

for (const args of checks) {
  const label = `npm ${args.join(" ")}`;
  console.log(`\n[SmartST PoC] START ${label}`);
  const exitCode = await runNpm(args);
  if (exitCode !== 0) {
    console.error(`[SmartST PoC] FAIL ${label} exit=${exitCode}`);
    process.exit(exitCode);
  }
  console.log(`[SmartST PoC] PASS ${label}`);
}

const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\n[SmartST PoC] ALL PASS in ${durationSeconds}s`);

function runNpm(args) {
  if (npmCliPath) {
    return run(process.execPath, [npmCliPath, ...args]);
  }
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  return run(npmCommand, args, process.platform === "win32");
}

function run(command, args, shell = false) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell,
    });
    child.on("error", (error) => {
      console.error(error);
      resolve(1);
    });
    child.on("close", (exitCode) => {
      resolve(exitCode ?? 0);
    });
  });
}
