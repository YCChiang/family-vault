#Requires -Version 5.1
<#
.SYNOPSIS
    Shared helpers for the family-vault client scripts.
.DESCRIPTION
    Reads the vault config (for bind/port/tokenFile) and talks to the token API.

    RULES
      1. The token is read from the token file and never printed, logged or written anywhere.
      2. Field values are never written to standard output by these helpers; only
         vault-send.ps1 handles a value, and only to hand it to a sender script.
#>
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Get-VaultConfigPath {
    param([string]$ConfigPath)
    if ($ConfigPath) { return $ConfigPath }
    if ($env:VAULT_CONFIG) { return $env:VAULT_CONFIG }
    return (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'config.json')
}

function Get-VaultConfig {
    param([string]$ConfigPath)
    $p = Get-VaultConfigPath $ConfigPath
    if (-not (Test-Path -LiteralPath $p)) { throw "vault config not found: $p" }
    $raw = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)
    $cfg = $raw.TrimStart([char]0xFEFF) | ConvertFrom-Json
    # relative paths in config.json resolve against the config file's directory
    $dir = Split-Path -Parent (Resolve-Path -LiteralPath $p).Path
    $cfg | Add-Member -NotePropertyName '_dir' -NotePropertyValue $dir -Force
    return $cfg
}

function Get-VaultBaseUrl {
    param([string]$ConfigPath)
    $cfg = Get-VaultConfig $ConfigPath
    $hostName = [string]$cfg.bind
    if ($hostName -eq '0.0.0.0' -or $hostName -eq '::' -or [string]::IsNullOrWhiteSpace($hostName)) { $hostName = '127.0.0.1' }
    return "http://${hostName}:$($cfg.port)"
}

function Resolve-VaultPath {
    param([string]$ConfigPath, [string]$Path)
    if ([System.IO.Path]::IsPathRooted($Path)) { return $Path }
    return (Join-Path (Get-VaultConfig $ConfigPath)._dir $Path)
}

function Get-VaultToken {
    param([string]$ConfigPath)
    $cfg = Get-VaultConfig $ConfigPath
    $tf = Resolve-VaultPath -ConfigPath $ConfigPath -Path $cfg.tokenFile
    if (-not (Test-Path -LiteralPath $tf)) { throw "vault is not initialized yet (no token file): $tf" }
    return ([System.IO.File]::ReadAllText($tf, [System.Text.Encoding]::UTF8)).Trim()
}

# single GET helper: returns @{ status; data } and does not throw on HTTP errors
function Invoke-VaultGet {
    param([Parameter(Mandatory = $true)][string]$Path, [string]$ConfigPath)
    $url = (Get-VaultBaseUrl $ConfigPath) + $Path
    $headers = @{ 'X-Vault-Token' = (Get-VaultToken $ConfigPath) }
    try {
        return @{ status = 200; data = (Invoke-RestMethod -Uri $url -Headers $headers -Method Get -TimeoutSec 20) }
    } catch {
        $code = 0; $body = $null
        if ($_.Exception.Response) {
            $code = [int]$_.Exception.Response.StatusCode
            try { $body = (New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() | ConvertFrom-Json } catch { }
        }
        if ($code -eq 0) { throw "vault unreachable: $($_.Exception.Message)" }
        if ($code -eq 401) { throw 'vault refused the API token (401)' }
        return @{ status = $code; data = $body }
    }
}

# names / appellations / field labels only - never values
function Get-VaultIndex {
    param([string]$ConfigPath)
    $r = Invoke-VaultGet -Path '/api/index' -ConfigPath $ConfigPath
    if ($r.status -eq 200) { return $r.data }
    throw "vault request failed: HTTP $($r.status)"
}

function Get-VaultPersonNames {
    param([string]$ConfigPath)
    $idx = Get-VaultIndex -ConfigPath $ConfigPath
    return (@($idx.people) | ForEach-Object {
            if ($_.appellation) { "$($_.name) ($($_.appellation))" } else { $_.name }
        }) -join ', '
}

# resolve a name OR appellation to one person; returns @{ name; appellation; fields; matchedBy }
function Resolve-VaultPerson {
    param([Parameter(Mandatory = $true)][string]$Query, [string]$ConfigPath)
    $r = Invoke-VaultGet -Path ('/api/lookup?name=' + [uri]::EscapeDataString($Query)) -ConfigPath $ConfigPath
    if ($r.status -eq 200) { return $r.data }
    if ($r.status -eq 404) { throw ("no such person: {0}; known: {1}" -f $Query, (Get-VaultPersonNames -ConfigPath $ConfigPath)) }
    if ($r.status -eq 409) { throw ("ambiguous: {0} -> {1}" -f $Query, (@($r.data.candidates) -join ', ')) }
    throw "vault request failed: HTTP $($r.status)"
}

# one field value; the caller must hand it to a sender and never print it
function Get-VaultFieldValue {
    param(
        [Parameter(Mandatory = $true)][string]$Query,
        [Parameter(Mandatory = $true)][string]$Field,
        [string]$ConfigPath
    )
    $path = '/api/lookup?name=' + [uri]::EscapeDataString($Query) + '&field=' + [uri]::EscapeDataString($Field)
    $r = Invoke-VaultGet -Path $path -ConfigPath $ConfigPath
    if ($r.status -eq 200) { return $r.data }
    if ($r.status -eq 404) { throw ("no such field: {0} on {1}" -f $Field, $Query) }
    throw "vault request failed: HTTP $($r.status)"
}
