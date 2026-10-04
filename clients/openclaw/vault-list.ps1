#Requires -Version 5.1
<#
.SYNOPSIS
    List the people in the vault (names, appellations, field labels - never values).
.EXAMPLE
    powershell -NoProfile -File vault-list.ps1
    powershell -NoProfile -File vault-list.ps1 -Name 妈妈
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Name = '',
    [string]$ConfigPath = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'vault-common.ps1')

try {
    $idx = Get-VaultIndex -ConfigPath $ConfigPath
    $people = @($idx.people)

    if ($Name) {
        $hit = Resolve-VaultPerson -Query $Name -ConfigPath $ConfigPath
        $people = @($people | Where-Object { $_.name -eq $hit.name })
        if ($hit.matchedBy -eq 'appellation') { Write-Output ("（「{0}」matched by appellation -> {1}）" -f $Name, $hit.name) }
    }

    if ($people.Count -eq 0) { Write-Output '(vault is empty)'; exit 0 }

    foreach ($p in $people) {
        $app = if ($p.appellation) { "（$($p.appellation)）" } else { '' }
        Write-Output ("姓名：{0}{1}" -f $p.name, $app)
        $fields = @($p.fields)
        if ($fields.Count -gt 0) { Write-Output ("  可查字段：{0}" -f ($fields -join '、')) }
        else { Write-Output '  可查字段：（无）' }
        if ($p.hasNotes) { Write-Output '  另有备注（备注不对 API 开放）' }
        Write-Output ''
    }
} catch {
    [Console]::Error.WriteLine("[错误] $($_.Exception.Message)")
    exit 1
}
