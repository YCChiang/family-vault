# ---------------------------------------------------------------------------
#  Push guard: refuse to publish anything that looks like data, a key or a token.
#
#  What matters is what git would actually upload, so:
#    * a matching file that is tracked or staged   -> FAIL (would be pushed)
#    * a matching file present but NOT ignored     -> FAIL (a later `git add -A` would push it)
#    * a matching file present but git-ignored     -> WARN only (stays local)
#
#  Usage:  powershell -ExecutionPolicy Bypass -File scripts/check-no-data.ps1
#  Exit code 0 = nothing will be published, 1 = blocked.
# ---------------------------------------------------------------------------
[CmdletBinding()]
param(
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
# $PSScriptRoot is not reliable inside a param default
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
if (-not $RepoRoot -or -not (Test-Path -LiteralPath $RepoRoot)) { throw "cannot determine repo root: '$RepoRoot'" }

$patterns = @(
    '^config\.json$', '^config\.(?!example)[a-z0-9_.-]*\.json$', '^api-token\.txt$',
    '\.dat$', '\.key$', '\.dpapi$',
    '^vault-send-.*\.txt$', '\.log$', '\.log\.err$', '\.pem$', '\.pfx$'
)
function Test-SensitiveName {
    param([string]$Leaf)
    foreach ($pat in $patterns) { if ($Leaf -match $pat) { return $true } }
    return $false
}

$isRepo = Test-Path -LiteralPath (Join-Path $RepoRoot '.git')
$blocked = @()
$warned = @()

# --- 1) tracked or staged files: these WOULD be published -------------------
if ($isRepo) {
    $tracked = @(& git -C $RepoRoot ls-files)
    $staged = @(& git -C $RepoRoot diff --cached --name-only)
    foreach ($f in (($tracked + $staged) | Sort-Object -Unique)) {
        if (Test-SensitiveName (Split-Path -Leaf $f)) { $blocked += "would be pushed: $f" }
    }
}

# --- 2) files present in the working tree ----------------------------------
$skip = @('\.git\', '\node_modules\')
$present = Get-ChildItem -LiteralPath $RepoRoot -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object {
    $p = $_.FullName
    -not ($skip | Where-Object { $p -like "*$_*" })
}
foreach ($f in $present) {
    if (-not (Test-SensitiveName $f.Name)) { continue }
    $rel = $f.FullName.Substring($RepoRoot.Length).TrimStart('\', '/')
    if ($isRepo) {
        & git -C $RepoRoot check-ignore -q -- $rel
        if ($LASTEXITCODE -eq 0) {
            $warned += "$rel (git-ignored, stays local)"
            continue
        }
    }
    $blocked += "not ignored: $rel - a plain 'git add -A' would push it"
}

# --- 3) obvious secrets inside tracked text files --------------------------
if ($isRepo) {
    $secretish = 'X-Vault-Token"\s*:\s*"[A-Za-z0-9_\-]{20,}|BEGIN [A-Z ]*PRIVATE KEY'
    foreach ($t in @(& git -C $RepoRoot ls-files)) {
        if ($t -match '\.(png|jpg|jpeg|gif|webp|ico|zip|gz|exe|dll)$') { continue }
        $full = Join-Path $RepoRoot $t
        if (-not (Test-Path -LiteralPath $full)) { continue }
        $hit = Select-String -LiteralPath $full -Pattern $secretish -ErrorAction SilentlyContinue
        if ($hit) { $blocked += "looks like a secret: $t (line $($hit[0].LineNumber))" }
    }
}

if ($warned.Count -gt 0) {
    Write-Output 'Local-only files (will NOT be uploaded):'
    $warned | Sort-Object -Unique | ForEach-Object { Write-Output "   - $_" }
    Write-Output ''
}

if ($blocked.Count -gt 0) {
    Write-Output 'BLOCKED - these would end up on the remote:'
    $blocked | Sort-Object -Unique | ForEach-Object { Write-Output "   - $_" }
    Write-Output ''
    Write-Output 'Data, keys and real configs must never enter the repository. Move them outside the'
    Write-Output 'repo directory (e.g. %LOCALAPPDATA%\family-vault\) and point VAULT_CONFIG at them,'
    Write-Output 'or make sure .gitignore covers them.'
    exit 1
}

Write-Output 'OK: nothing that looks like data, a key, a token or a real config would be published.'
exit 0
