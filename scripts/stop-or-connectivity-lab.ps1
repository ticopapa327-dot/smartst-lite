param(
  [string]$StatePath = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $StatePath) {
  $StatePath = Join-Path $repoRoot "runtime\or-connectivity\processes.json"
}

if (-not (Test-Path -LiteralPath $StatePath)) {
  Write-Output "No SmartST OR connectivity lab process state was found at $StatePath."
  exit 0
}

$state = Get-Content -Raw -Encoding UTF8 -LiteralPath $StatePath | ConvertFrom-Json
$stopped = @()

foreach ($processInfo in $state.processes) {
  $pidValue = [int]$processInfo.pid
  $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  if (-not $process) {
    $stopped += [pscustomobject]@{
      name = $processInfo.name
      pid = $pidValue
      status = "not-running"
    }
    continue
  }

  Stop-Process -Id $pidValue -Force
  $stopped += [pscustomobject]@{
    name = $processInfo.name
    pid = $pidValue
    status = "stopped"
  }
}

[pscustomobject]@{
  schemaVersion = "smartst.or-connectivity-lab.stop.v0.1"
  stoppedAt = (Get-Date).ToString("o")
  statePath = $StatePath
  stopped = $stopped
} | ConvertTo-Json -Depth 5
