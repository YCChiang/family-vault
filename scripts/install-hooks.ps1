# ---------------------------------------------------------------------------
#  Point git at the repository's own hooks (.githooks), so the data guard runs
#  before every commit. Run once after cloning.
#
#    powershell -ExecutionPolicy Bypass -File scripts/install-hooks.ps1
# ---------------------------------------------------------------------------
[CmdletBinding()]
param([string]$RepoRoot = '')

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot '.git'))) { throw "$RepoRoot is not a git repository" }

& git -C $RepoRoot config core.hooksPath .githooks
if ($LASTEXITCODE -ne 0) { throw 'failed to set core.hooksPath' }

Write-Output ("core.hooksPath = " + (& git -C $RepoRoot config --get core.hooksPath))
Write-Output 'pre-commit guard enabled: commits containing data/keys/tokens will be refused.'
Write-Output 'Verify with:  powershell -ExecutionPolicy Bypass -File scripts/check-no-data.ps1'
