# ---------------------------------------------------------------------------
#  Push guard: refuse to publish anything that looks like data, a key or a token.
#
#  What matters is what git would actually upload, so:
#    * a matching file that is tracked or staged      -> FAIL (would be pushed)
#    * a matching file present but NOT ignored        -> FAIL (a later `git add -A` would push it)
#    * a matching file present but git-ignored        -> WARN only (stays local)
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
        if (Test-SensitiveName (Split-Path -Leaf $f)) { $blocked += "会被上传：$f" }
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
            $warned += "$rel（已被 .gitignore 排除，只留在本机）"
            continue
        }
    }
    $blocked += "未忽略：$rel —— 一旦 git add -A 就会被上传"
}

# --- 3) obvious secrets inside tracked text files --------------------------
if ($isRepo) {
    $secretish = 'X-Vault-Token"\s*:\s*"[A-Za-z0-9_\-]{20,}|BEGIN [A-Z ]*PRIVATE KEY'
    foreach ($t in @(& git -C $RepoRoot ls-files)) {
        if ($t -match '\.(png|jpg|jpeg|gif|webp|ico|zip|gz|exe|dll)$') { continue }
        $full = Join-Path $RepoRoot $t
        if (-not (Test-Path -LiteralPath $full)) { continue }
        $hit = Select-String -LiteralPath $full -Pattern $secretish -ErrorAction SilentlyContinue
        if ($hit) { $blocked += "疑似密钥内容：$t（第 $($hit[0].LineNumber) 行）" }
    }
}

if ($warned.Count -gt 0) {
    Write-Output '本机存在这些文件（不会上传，仅提醒）：'
    $warned | Sort-Object -Unique | ForEach-Object { Write-Output "   - $_" }
    Write-Output ''
}

if ($blocked.Count -gt 0) {
    Write-Output '❌ 会被上传的内容，已阻止：'
    $blocked | Sort-Object -Unique | ForEach-Object { Write-Output "   - $_" }
    Write-Output ''
    Write-Output '数据 / 密钥 / 真实配置一律不进仓库。把它们移出仓库目录（例如 %LOCALAPPDATA%\family-vault\），'
    Write-Output '用 VAULT_CONFIG 环境变量指向，或确认 .gitignore 覆盖它们。'
    exit 1
}

Write-Output '✅ 什么都没问题：没有会被上传的数据文件、密钥、令牌或真实配置。'
exit 0
