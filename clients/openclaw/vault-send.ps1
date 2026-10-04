#Requires -Version 5.1
<#
.SYNOPSIS
    Send vault values straight to a human, without the values entering any log or context.
.DESCRIPTION
    Flow: token API -> short-lived UTF-8 file -> your sender script -> delete the file.

    The sender is any script that accepts -TextFile <path> and delivers that text
    (e.g. to a chat DM). There is deliberately no recipient parameter here: pick the
    recipient inside your sender script so this tool cannot be aimed at someone else.

    The value is never printed. Only metadata ("sent person=... fields=...") is.

    Temp files live in %TEMP%\family-vault-send (override with -TempDir) and are deleted
    twice - right after the sender returns, and in a finally block - plus leftovers older
    than two minutes are purged on every run.
.PARAMETER Name
    Person name or appellation (爸爸 / 妈妈 / ...). Ambiguity is an error, not a guess.
.PARAMETER Field
    One or more field labels, comma separated. Omit to send every non-empty field.
.PARAMETER SenderScript
    Script that accepts -TextFile and delivers it. Required unless -DryRun.
.EXAMPLE
    powershell -NoProfile -File vault-send.ps1 -Name 妈妈 -Field 身份证号 -SenderScript .\send-to-me.ps1
    powershell -NoProfile -File vault-send.ps1 -Name 爸爸 -DryRun
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Name,
    [Parameter(Position = 1)][string]$Field = '',
    [string]$SenderScript = '',
    [string]$ConfigPath = '',
    [string]$TempDir = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'vault-common.ps1')

if (-not $TempDir) { $TempDir = Join-Path $env:TEMP 'family-vault-send' }
$tmp = ''
$exitCode = 0

try {
    # purge leftovers from a previous run that was killed before it could clean up
    if (Test-Path -LiteralPath $TempDir) {
        Get-ChildItem -LiteralPath $TempDir -Filter 'vault-send-*.txt' -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -lt (Get-Date).AddMinutes(-2) } |
            Remove-Item -Force -ErrorAction SilentlyContinue
    }

    $person = Resolve-VaultPerson -Query $Name -ConfigPath $ConfigPath
    if ($person.matchedBy -eq 'appellation') { Write-Output ("（「{0}」matched by appellation -> {1}）" -f $Name, $person.name) }

    $available = @($person.fields)
    if ($available.Count -eq 0) { throw ("no fields recorded for {0}" -f $person.name) }

    $wanted = @()
    if ($Field) {
        foreach ($piece in ($Field -split '[,，、;]')) {
            $f = $piece.Trim(); if (-not $f) { continue }
            $hit = $available | Where-Object { $_ -eq $f } | Select-Object -First 1
            if (-not $hit) { $hit = $available | Where-Object { $_ -like "*$f*" } | Select-Object -First 1 }
            if (-not $hit) { throw ("{0} has no field {1}; available: {2}" -f $person.name, $f, ($available -join ', ')) }
            if ($wanted -notcontains $hit) { $wanted += $hit }
        }
    } else {
        $wanted = $available
    }
    if ($wanted.Count -eq 0) { throw 'nothing to send' }

    $app = if ($person.appellation) { "（$($person.appellation)）" } else { '' }
    $lines = @("$($person.name)$app")
    foreach ($f in $wanted) {
        $r = Get-VaultFieldValue -Query $person.name -Field $f -ConfigPath $ConfigPath
        $v = [string]$r.value
        if ([string]::IsNullOrWhiteSpace($v)) { continue }
        $lines += ("{0}：{1}" -f $r.field, $v)
    }
    if ($lines.Count -le 1) { throw 'all requested fields are empty' }
    $text = ($lines -join "`r`n")

    New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
    $tmp = Join-Path $TempDir ("vault-send-{0}.txt" -f [guid]::NewGuid().ToString('N'))
    [System.IO.File]::WriteAllText($tmp, $text, (New-Object System.Text.UTF8Encoding($false)))

    if ($DryRun) {
        Write-Output ("DRY-RUN would send {0} field(s) of {1} ({2}); values not shown" -f $wanted.Count, $person.name, ($wanted -join ', '))
    } else {
        if (-not $SenderScript) { throw '-SenderScript is required (unless -DryRun)' }
        if (-not (Test-Path -LiteralPath $SenderScript)) { throw "sender not found: $SenderScript" }
        $out = & powershell -NoProfile -File $SenderScript -TextFile $tmp
        $code = $LASTEXITCODE
        $outText = ($out | Out-String).Trim()
        if ($code -ne 0) { throw ("sender failed (exit={0}): {1}" -f $code, $outText) }
        Write-Output ("SENT {0} field(s) of {1} ({2}); values not echoed" -f $wanted.Count, $person.name, ($wanted -join ', '))
        if ($outText) { Write-Output $outText }
    }
    # delete the moment the sender returns; the finally block is only a backstop
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    $tmp = ''
} catch {
    [Console]::Error.WriteLine("[错误] $($_.Exception.Message)")
    $exitCode = 1
} finally {
    if ($tmp -and (Test-Path -LiteralPath $tmp)) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}
exit $exitCode
