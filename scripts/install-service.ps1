# ---------------------------------------------------------------------------
#  Register family-vault as a Windows service with NSSM (https://nssm.cc/).
#  The service runs the code in this repository; all data and the real config
#  stay OUTSIDE it (see config.example.json and SECURITY.md).
# ---------------------------------------------------------------------------
[CmdletBinding()]
param(
    [string]$ServiceName = 'family-vault',
    [string]$RepoRoot = '',
    [string]$ConfigPath = '',
    [string]$NodePath = '',
    [string]$LogDir = ''
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
if (-not $NodePath) { $NodePath = (Get-Command node -ErrorAction Stop).Source }
if (-not $ConfigPath) { $ConfigPath = Join-Path $RepoRoot 'config.json' }
if (-not $LogDir) { $LogDir = Join-Path (Split-Path -Parent $ConfigPath) 'logs' }
$server = Join-Path $RepoRoot 'vault-server.mjs'

foreach ($p in @($NodePath, $server)) { if (-not (Test-Path -LiteralPath $p)) { throw "not found: $p" } }
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "config not found: $ConfigPath - copy config.example.json somewhere outside the repo first."
}
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) { throw 'nssm not found (choco install nssm / scoop install nssm), or create the service manually.' }

if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
    & $nssm stop $ServiceName | Out-Null
    & $nssm remove $ServiceName confirm | Out-Null
}
& $nssm install $ServiceName $NodePath $server
& $nssm set $ServiceName AppDirectory $RepoRoot
& $nssm set $ServiceName DisplayName 'family-vault'
& $nssm set $ServiceName Description 'Encrypted family information store (loopback only; put a proxy in front).'
& $nssm set $ServiceName Start SERVICE_AUTO_START
& $nssm set $ServiceName AppEnvironmentExtra "VAULT_CONFIG=$ConfigPath"
& $nssm set $ServiceName AppStdout (Join-Path $LogDir 'family-vault.log')
& $nssm set $ServiceName AppStderr (Join-Path $LogDir 'family-vault.err.log')
& $nssm set $ServiceName AppRotateFiles 1
& $nssm set $ServiceName AppRotateBytes 1048576
& $nssm set $ServiceName AppExit Default Restart
& $nssm set $ServiceName AppRestartDelay 5000
& $nssm start $ServiceName

Start-Sleep -Seconds 2
Get-Service $ServiceName | Select-Object Name, Status, StartType | Format-Table -AutoSize
$port = (Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json).port
try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 10
    "health: $($h | ConvertTo-Json -Compress)"
} catch {
    "service registered, but the health check failed: $($_.Exception.Message) (check $LogDir)"
}
