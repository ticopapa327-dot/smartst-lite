param(
  [string]$Version = "latest",
  [string]$Destination = ""
)

$ErrorActionPreference = "Stop"

function Get-RepoRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

function Invoke-GitHubJson {
  param([string]$Uri)
  return Invoke-RestMethod -Uri $Uri -Headers @{ "User-Agent" = "SmartST-Lite" }
}

$repoRoot = Get-RepoRoot
if (-not $Destination) {
  $Destination = Join-Path $repoRoot "runtime\livekit"
}

New-Item -ItemType Directory -Force -Path $Destination | Out-Null

if ($Version -eq "latest") {
  $release = Invoke-GitHubJson "https://api.github.com/repos/livekit/livekit/releases/latest"
} else {
  $release = Invoke-GitHubJson "https://api.github.com/repos/livekit/livekit/releases/tags/$Version"
}

$asset = $release.assets |
  Where-Object { $_.name -like "*windows_amd64.zip" } |
  Select-Object -First 1

if (-not $asset) {
  throw "LiveKit Windows AMD64 asset was not found in release $($release.tag_name)."
}

$zipPath = Join-Path $Destination $asset.name
$checksumsPath = Join-Path $Destination "checksums.txt"

Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -Headers @{ "User-Agent" = "SmartST-Lite" }
Invoke-WebRequest -Uri "https://github.com/livekit/livekit/releases/download/$($release.tag_name)/checksums.txt" -OutFile $checksumsPath -Headers @{ "User-Agent" = "SmartST-Lite" }

$expectedLine = Get-Content -Encoding UTF8 $checksumsPath |
  Where-Object { $_ -match [regex]::Escape($asset.name) } |
  Select-Object -First 1

if (-not $expectedLine) {
  throw "Checksum entry was not found for $($asset.name)."
}

$expectedHash = (($expectedLine -split "\s+")[0]).ToLowerInvariant()
$actualHash = (Get-FileHash -Algorithm SHA256 $zipPath).Hash.ToLowerInvariant()

if ($actualHash -ne $expectedHash) {
  throw "Checksum mismatch for $($asset.name). expected=$expectedHash actual=$actualHash"
}

Expand-Archive -Path $zipPath -DestinationPath $Destination -Force

$exePath = Join-Path $Destination "livekit-server.exe"
if (-not (Test-Path -LiteralPath $exePath)) {
  throw "livekit-server.exe was not found after extracting $($asset.name)."
}

& $exePath --version

[pscustomobject]@{
  status = "installed"
  release = $release.tag_name
  asset = $asset.name
  destination = $Destination
  executablePath = $exePath
  checksum = $actualHash
} | ConvertTo-Json -Depth 4
