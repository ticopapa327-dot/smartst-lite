param(
  [string]$LanIp = "",
  [string]$LiveKitExe = "",
  [string]$ApiKey = "ust-dev-key",
  [string]$ApiSecret = "",
  [int]$BusinessPort = 4780,
  [int]$WebObserverPort = 5175,
  [switch]$NoWebObserver
)

$ErrorActionPreference = "Stop"

function Get-RepoRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

function New-DevSecret {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  return (($bytes | ForEach-Object { $_.ToString("x2") }) -join "")
}

function Resolve-LabIp {
  function Test-PrivateIPv4 {
    param([string]$Address)
    if ($Address -like "10.*") {
      return $true
    }
    if ($Address -like "192.168.*") {
      return $true
    }
    if ($Address -match "^172\.(1[6-9]|2[0-9]|3[0-1])\.") {
      return $true
    }
    return $false
  }

  $gatewayCandidate = Get-NetIPConfiguration |
    Where-Object {
      $_.IPv4Address -and
      $_.IPv4DefaultGateway -and
      (Test-PrivateIPv4 $_.IPv4Address.IPAddress) -and
      $_.InterfaceAlias -notmatch "vEthernet|Virtual|Loopback|Docker|VMware|Hyper-V|VPN|TAP|CMY"
    } |
    Select-Object -First 1

  if ($gatewayCandidate) {
    return $gatewayCandidate.IPv4Address.IPAddress
  }

  $candidate = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
      $_.IPAddress -notlike "127.*" -and
      $_.IPAddress -notlike "169.254.*" -and
      $_.IPAddress -notlike "198.18.*" -and
      $_.IPAddress -notlike "198.19.*" -and
      (Test-PrivateIPv4 $_.IPAddress) -and
      $_.InterfaceAlias -notmatch "vEthernet|Virtual|Loopback|Docker|VMware|Hyper-V"
    } |
    Select-Object -First 1

  if (-not $candidate) {
    throw "No usable LAN IPv4 address was found. Pass -LanIp explicitly."
  }

  return $candidate.IPAddress
}

function Resolve-LiveKitExe {
  param([string]$RequestedPath, [string]$RepoRoot)

  if ($RequestedPath) {
    $resolved = (Resolve-Path -LiteralPath $RequestedPath).Path
    return $resolved
  }

  $runtimeExe = Join-Path $RepoRoot "runtime\livekit\livekit-server.exe"
  if (Test-Path -LiteralPath $runtimeExe) {
    return $runtimeExe
  }

  $command = Get-Command livekit-server -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  throw "livekit-server.exe was not found. Run npm run livekit:install-dev first."
}

function Assert-TcpPortFree {
  param([int]$Port, [string]$Name)
  $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($listeners) {
    $owners = ($listeners | Select-Object -ExpandProperty OwningProcess -Unique) -join ","
    throw "$Name TCP port $Port is already listening. owningProcess=$owners"
  }
}

function Assert-UdpPortFree {
  param([int]$Port, [string]$Name)
  $listeners = Get-NetUDPEndpoint -LocalPort $Port -ErrorAction SilentlyContinue
  if ($listeners) {
    $owners = ($listeners | Select-Object -ExpandProperty OwningProcess -Unique) -join ","
    throw "$Name UDP port $Port is already bound. owningProcess=$owners"
  }
}

function Start-LabProcess {
  param(
    [string]$Name,
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory,
    [string]$LogDirectory
  )

  function Join-ProcessArguments {
    param([string[]]$ArgValues)
    $quoted = @()
    foreach ($arg in $ArgValues) {
      if ($arg -match '[\s"]') {
        $quoted += '"' + ($arg -replace '"', '\"') + '"'
      } else {
        $quoted += $arg
      }
    }
    return ($quoted -join " ")
  }

  $stdoutPath = Join-Path $LogDirectory "$Name.out.log"
  $stderrPath = Join-Path $LogDirectory "$Name.err.log"
  $argumentString = Join-ProcessArguments -ArgValues $ArgumentList

  $process = Start-Process `
    -FilePath $FilePath `
    -ArgumentList $argumentString `
    -WorkingDirectory $WorkingDirectory `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru

  Start-Sleep -Milliseconds 800
  if ($process.HasExited) {
    throw "$Name exited early with code $($process.ExitCode). Check $stdoutPath and $stderrPath."
  }

  return [pscustomobject]@{
    name = $Name
    pid = $process.Id
    filePath = $FilePath
    stdout = $stdoutPath
    stderr = $stderrPath
  }
}

function Wait-TcpPort {
  param([int]$Port, [int]$TimeoutSeconds = 20)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
      $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
      if ($async.AsyncWaitHandle.WaitOne(500)) {
        $client.EndConnect($async)
        return
      }
    } catch {
    } finally {
      $client.Close()
    }
    Start-Sleep -Milliseconds 300
  }

  throw "TCP port $Port did not become reachable within $TimeoutSeconds seconds."
}

function Wait-HttpOk {
  param([string]$Url, [int]$TimeoutSeconds = 20)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      Invoke-RestMethod -Uri $Url -TimeoutSec 2 | Out-Null
      return
    } catch {
      Start-Sleep -Milliseconds 300
    }
  }

  throw "$Url did not become reachable within $TimeoutSeconds seconds."
}

function Save-Env {
  param([string[]]$Names)
  $saved = @{}
  foreach ($name in $Names) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
  }
  return $saved
}

function Restore-Env {
  param([hashtable]$Saved)
  foreach ($name in $Saved.Keys) {
    if ($null -eq $Saved[$name]) {
      Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    } else {
      Set-Item "Env:$name" $Saved[$name]
    }
  }
}

$repoRoot = Get-RepoRoot
$runtimeDir = Join-Path $repoRoot "runtime\or-connectivity"
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

if (-not $LanIp) {
  $LanIp = Resolve-LabIp
}

if (-not $ApiSecret) {
  $ApiSecret = New-DevSecret
}

$LiveKitExe = Resolve-LiveKitExe -RequestedPath $LiveKitExe -RepoRoot $repoRoot
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$viteCli = Join-Path $repoRoot "node_modules\vite\bin\vite.js"
if (-not (Test-Path -LiteralPath $viteCli)) {
  throw "Vite CLI was not found. Run npm install first."
}

Assert-TcpPortFree -Port 7880 -Name "LiveKit HTTP"
Assert-TcpPortFree -Port 7881 -Name "LiveKit ICE TCP"
Assert-UdpPortFree -Port 7882 -Name "LiveKit ICE UDP"
Assert-TcpPortFree -Port $BusinessPort -Name "UST business service"
if (-not $NoWebObserver) {
  Assert-TcpPortFree -Port $WebObserverPort -Name "UST web observer"
}

$keyFile = Join-Path $runtimeDir "livekit.keys"
Set-Content -LiteralPath $keyFile -Encoding ASCII -Value "$ApiKey`: $ApiSecret"

$processes = @()
$savedLiveKitEnv = Save-Env @("LIVEKIT_KEYS")
try {
  $env:LIVEKIT_KEYS = "$ApiKey`: $ApiSecret"
  $processes += Start-LabProcess `
    -Name "livekit" `
    -FilePath $LiveKitExe `
    -ArgumentList @("--dev", "--bind", "0.0.0.0", "--node-ip", $LanIp) `
    -WorkingDirectory $repoRoot `
    -LogDirectory $runtimeDir
} finally {
  Restore-Env $savedLiveKitEnv
}

Wait-TcpPort -Port 7880

$savedBusinessEnv = Save-Env @(
  "UST_POC_HOST",
  "UST_POC_PORT",
  "LIVEKIT_TOKEN_MODE",
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET"
)

try {
  $env:UST_POC_HOST = "0.0.0.0"
  $env:UST_POC_PORT = [string]$BusinessPort
  $env:LIVEKIT_TOKEN_MODE = "real"
  $env:LIVEKIT_URL = "ws://$LanIp`:7880"
  $env:LIVEKIT_API_KEY = $ApiKey
  $env:LIVEKIT_API_SECRET = $ApiSecret

  $processes += Start-LabProcess `
    -Name "business-service" `
    -FilePath $nodeExe `
    -ArgumentList @("server-poc/server.mjs") `
    -WorkingDirectory $repoRoot `
    -LogDirectory $runtimeDir
} finally {
  Restore-Env $savedBusinessEnv
}

Wait-HttpOk -Url "http://127.0.0.1:$BusinessPort/health"

if (-not $NoWebObserver) {
  $savedWebEnv = Save-Env @("UST_WEB_OBSERVER_HOST", "UST_WEB_OBSERVER_PORT")
  try {
    $env:UST_WEB_OBSERVER_HOST = "0.0.0.0"
    $env:UST_WEB_OBSERVER_PORT = [string]$WebObserverPort

    $processes += Start-LabProcess `
      -Name "web-observer" `
      -FilePath $nodeExe `
      -ArgumentList @($viteCli, "--config", "web-observer-poc/vite.config.ts") `
      -WorkingDirectory $repoRoot `
      -LogDirectory $runtimeDir
  } finally {
    Restore-Env $savedWebEnv
  }

  Wait-HttpOk -Url "http://127.0.0.1:$WebObserverPort/"
}

$state = [pscustomobject]@{
  schemaVersion = "ust.or-connectivity-lab.v0.1"
  startedAt = (Get-Date).ToString("o")
  lanIp = $LanIp
  apiKey = $ApiKey
  livekitUrl = "ws://$LanIp`:7880"
  businessUrl = "http://$LanIp`:$BusinessPort"
  webObserverUrl = if ($NoWebObserver) { $null } else { "http://$LanIp`:$WebObserverPort" }
  keyFile = $keyFile
  apiSecretStored = "runtime-only"
  processes = $processes
}

$statePath = Join-Path $runtimeDir "processes.json"
$state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding UTF8
$state | ConvertTo-Json -Depth 6
