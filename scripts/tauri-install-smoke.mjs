import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
const productName = "SmartST Lite";
const executableName = "smartst-lite.exe";
const workerName = "smartst-native-worker.exe";
const installerPath = resolve(
  rootDir,
  "src-tauri/target/release/bundle/nsis",
  `${productName}_${packageJson.version}_x64-setup.exe`,
);
const installBase = process.env.LOCALAPPDATA || process.env.TEMP || rootDir;
const installDir =
  process.env.SMARTST_NSIS_INSTALL_DIR ||
  join(installBase, `SmartSTLiteNsisSmoke-${timestampForPath(new Date())}`);

assert(process.platform === "win32", "NSIS install smoke is Windows-only");
assert(existsSync(installerPath), `NSIS installer is missing: ${installerPath}`);
assertSafeTestInstallDir(installDir);

let installed = false;
let uninstallAttempted = false;

try {
  await cleanupExistingTestInstall();
  await cleanupSafeShortcutLeftovers();

  const install = await runChecked(installerPath, ["/S", `/D=${installDir}`], { timeoutMs: 180000 });
  installed = true;

  const installedFiles = verifyInstalledFiles(installDir);
  const registryAfterInstall = await queryInstallRegistry();
  assert(registryAfterInstall, "HKCU uninstall registry key is missing after install");
  assert(
    normalizeRegistryPath(registryAfterInstall.installLocation) === installDir,
    `registry install location mismatch: ${registryAfterInstall.installLocation}`,
  );

  const shortcutsAfterInstall = await queryShortcutState();
  assert(shortcutsAfterInstall.desktop.exists, "desktop shortcut is missing after install");
  assert(shortcutsAfterInstall.startMenu.exists, "Start Menu shortcut is missing after install");

  const installedWorkerSmoke = await smokeWorker(installedFiles.workerExe);
  const mainProcess = await smokeMainProcess(installedFiles.mainExe);

  const uninstall = await runChecked(installedFiles.uninstallExe, ["/S"], { timeoutMs: 120000 });
  uninstallAttempted = true;
  installed = false;

  await waitForUninstallCleanup(installDir, { timeoutMs: 30000 });
  const registryAfterUninstall = await queryInstallRegistry();
  const shortcutsAfterUninstall = await queryShortcutState();

  assert(!existsSync(installedFiles.mainExe), "main executable remains after uninstall");
  assert(!existsSync(installedFiles.workerExe), "native worker remains after uninstall");
  assert(!existsSync(installedFiles.uninstallExe), "uninstaller remains after uninstall");
  assert(!existsSync(installDir), `install directory remains after uninstall: ${installDir}`);
  assert(!registryAfterUninstall, "HKCU uninstall registry key remains after uninstall");
  assert(!shortcutsAfterUninstall.desktop.exists, "desktop shortcut remains after uninstall");
  assert(!shortcutsAfterUninstall.startMenu.exists, "Start Menu shortcut remains after uninstall");

  const result = {
    status: "passed",
    installerPath,
    installDir,
    installExitCode: install.exitCode,
    uninstallExitCode: uninstall.exitCode,
    installedFiles,
    registryAfterInstall,
    shortcutsAfterInstall,
    installedWorkerSmoke,
    mainProcess,
    uninstallResiduals: {
      installDirectoryExists: existsSync(installDir),
      registryExists: Boolean(registryAfterUninstall),
      desktopShortcutExists: shortcutsAfterUninstall.desktop.exists,
      startMenuShortcutExists: shortcutsAfterUninstall.startMenu.exists,
    },
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (installed && !uninstallAttempted) {
    await cleanupExistingTestInstall().catch(() => undefined);
  }
}

function verifyInstalledFiles(directory) {
  const mainExe = join(directory, executableName);
  const workerExe = join(directory, "bin", workerName);
  const uninstallExe = join(directory, "uninstall.exe");

  assert(existsSync(mainExe), `main executable is missing: ${mainExe}`);
  assert(existsSync(workerExe), `native worker is missing: ${workerExe}`);
  assert(existsSync(uninstallExe), `uninstaller is missing: ${uninstallExe}`);

  return {
    mainExe,
    workerExe,
    uninstallExe,
    mainExeBytes: fileBytes(mainExe),
    workerExeBytes: fileBytes(workerExe),
    uninstallExeBytes: fileBytes(uninstallExe),
  };
}

async function cleanupExistingTestInstall() {
  const existing = await queryInstallRegistry();
  if (!existing) return;

  const existingInstallLocation = normalizeRegistryPath(existing.installLocation);
  if (!isSafeTestInstallDir(existingInstallLocation)) {
    throw new Error(
      `Refusing to uninstall non-test SmartST Lite installation: ${existing.installLocation}`,
    );
  }

  const uninstallPath = normalizeUninstallString(existing.uninstallString);
  if (uninstallPath && existsSync(uninstallPath)) {
    await runChecked(uninstallPath, ["/S"], { timeoutMs: 120000 });
    await waitForUninstallCleanup(existingInstallLocation, { timeoutMs: 30000 });
  }

  await cleanupSafeShortcutLeftovers();
  if (existsSync(existingInstallLocation)) {
    rmSync(existingInstallLocation, { recursive: true, force: true });
  }
}

async function cleanupSafeShortcutLeftovers() {
  const state = await queryShortcutState();
  for (const shortcut of [state.desktop, state.startMenu]) {
    if (!shortcut.exists) continue;
    if (!isSafeTestInstallDir(shortcut.target ? dirname(shortcut.target) : "")) continue;
    await runPowerShell(
      `Remove-Item -LiteralPath $env:SMARTST_SHORTCUT_PATH -Force -ErrorAction SilentlyContinue`,
      { SMARTST_SHORTCUT_PATH: shortcut.path },
    );
  }
}

async function queryInstallRegistry() {
  const script = `
$path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SmartST Lite'
$item = Get-ItemProperty -LiteralPath $path -ErrorAction SilentlyContinue
if ($null -eq $item) {
  'null'
} else {
  [PSCustomObject]@{
    displayName = $item.DisplayName
    displayVersion = $item.DisplayVersion
    installLocation = $item.InstallLocation
    uninstallString = $item.UninstallString
  } | ConvertTo-Json -Compress
}
`;
  const output = await runPowerShell(script);
  return JSON.parse(output.stdout.trim() || "null");
}

async function queryShortcutState() {
  const script = `
$shell = New-Object -ComObject WScript.Shell
$items = @(
  [PSCustomObject]@{ name = 'desktop'; path = [System.IO.Path]::Combine([Environment]::GetFolderPath('Desktop'), 'SmartST Lite.lnk') },
  [PSCustomObject]@{ name = 'startMenu'; path = [System.IO.Path]::Combine([Environment]::GetFolderPath('StartMenu'), 'Programs\\SmartST Lite.lnk') }
)
$result = @{}
foreach ($item in $items) {
  $exists = Test-Path -LiteralPath $item.path
  $target = $null
  if ($exists) {
    try {
      $target = $shell.CreateShortcut($item.path).TargetPath
    } catch {
      $target = $null
    }
  }
  $result[$item.name] = [PSCustomObject]@{
    exists = $exists
    path = $item.path
    target = $target
  }
}
$result | ConvertTo-Json -Compress
`;
  const output = await runPowerShell(script);
  return JSON.parse(output.stdout.trim());
}

async function smokeWorker(workerPath) {
  const child = spawn(workerPath, [], {
    cwd: dirname(workerPath),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const pending = new Map();
  const events = [];
  let stdoutBuffer = "";
  let stderr = "";

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

  try {
    await waitForEvent("worker", "ready");
    const devices = await request("listDevices");
    assert(Array.isArray(devices.video), "installed worker video devices are not an array");
    assert(Array.isArray(devices.audio), "installed worker audio devices are not an array");
    assert(Array.isArray(devices.audioRender), "installed worker render devices are not an array");
    await request("shutdown");
    return {
      workerPath,
      source: devices.source,
      videoCount: devices.video.length,
      audioCount: devices.audio.length,
      audioRenderCount: devices.audioRender.length,
      mediaFoundationStatus: devices.diagnostics?.mediaFoundation?.status,
      wasapiStatus: devices.diagnostics?.wasapi?.status,
      wasapiRenderStatus: devices.diagnostics?.wasapiRender?.status,
    };
  } finally {
    child.stdin.end();
    child.kill();
  }

  function request(method, params) {
    const id = `${Date.now()}-${Math.random()}`;
    const payload = {
      id,
      method,
      ...(params ? { params } : {}),
    };

    const result = new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`${method} timed out. stderr=${stderr}`));
      }, 20000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          rejectPromise(error);
        },
      });
    });

    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return result;
  }

  function handleLine(line) {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (message.type === "event") {
      events.push(message.event);
      return;
    }
    if (message.type === "response") {
      const handler = pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id);
      if (message.ok) {
        handler.resolve(message.result);
        return;
      }
      handler.reject(new Error(message.error?.message || "native worker response failed"));
    }
  }

  function waitForEvent(category, name) {
    if (events.some((event) => event.category === category && event.name === name)) {
      return Promise.resolve();
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (events.some((event) => event.category === category && event.name === name)) {
          clearInterval(timer);
          resolvePromise();
          return;
        }
        if (Date.now() - startedAt > 20000) {
          clearInterval(timer);
          rejectPromise(new Error(`event ${category}.${name} timed out. stderr=${stderr}`));
        }
      }, 20);
    });
  }
}

async function smokeMainProcess(mainExe) {
  const script = `
$proc = Start-Process -FilePath $env:SMARTST_MAIN_EXE -PassThru
Start-Sleep -Seconds 5
$aliveAfter5s = -not $proc.HasExited
$closeRequested = $false
$forceKilled = $false
if ($aliveAfter5s) {
  $closeRequested = $proc.CloseMainWindow()
  Start-Sleep -Seconds 2
  if (-not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force
    $forceKilled = $true
  }
}
[PSCustomObject]@{
  mainExe = $env:SMARTST_MAIN_EXE
  processId = $proc.Id
  aliveAfter5s = $aliveAfter5s
  exitCode = $(if ($proc.HasExited) { $proc.ExitCode } else { $null })
  closeRequested = $closeRequested
  forceKilled = $forceKilled
} | ConvertTo-Json -Compress
`;
  const output = await runPowerShell(script, { SMARTST_MAIN_EXE: mainExe }, { timeoutMs: 30000 });
  const result = JSON.parse(output.stdout.trim());
  assert(result.aliveAfter5s === true, "installed main process did not stay alive for 5 seconds");
  assert(result.forceKilled === false, "installed main process required force kill");
  return result;
}

async function waitForUninstallCleanup(directory, { timeoutMs }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const registry = await queryInstallRegistry();
    if (!existsSync(directory) && !registry) return;
    await delay(500);
  }
}

async function runPowerShell(script, env = {}, options = {}) {
  return runChecked(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      timeoutMs: options.timeoutMs ?? 30000,
      env,
    },
  );
}

function runChecked(command, args, options = {}) {
  return run(command, args, options).then((result) => {
    if (result.exitCode !== 0) {
      throw new Error(
        `${command} exited ${result.exitCode}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
      );
    }
    return result;
  });
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`${command} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs ?? 30000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolvePromise({ exitCode: exitCode ?? 0, stdout, stderr });
    });
  });
}

function normalizeRegistryPath(value) {
  return String(value ?? "").replace(/^"|"$/g, "");
}

function normalizeUninstallString(value) {
  const text = String(value ?? "").trim();
  const quoted = text.match(/^"([^"]+)"/);
  if (quoted) return quoted[1];
  return text.split(/\s+/)[0] || "";
}

function assertSafeTestInstallDir(directory) {
  if (!isSafeTestInstallDir(directory)) {
    throw new Error(`Refusing unsafe NSIS test install directory: ${directory}`);
  }
}

function isSafeTestInstallDir(directory) {
  const normalized = normalizeRegistryPath(directory);
  return /SmartSTLiteNsis(?:Smoke|Test)-\d+/.test(normalized);
}

function timestampForPath(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function fileBytes(path) {
  return existsSync(path) ? statSync(path).size : 0;
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
