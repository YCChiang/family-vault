#Requires -Version 5.1
<#
.SYNOPSIS
    List the people in the vault: names, appellations and field labels - never values.
.DESCRIPTION
    Safe to show to a chat agent. Use it to discover which person/field to ask for.
.PARAMETER Name
    Optional. Person name OR appellation (e.g. mom / dad / uncle), partial match allowed.
.EXAMPLE
    powershell -NoProfile -File vault-list.ps1
    powershell -NoProfile -File vault-list.ps1 -Name mom
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
        if ($hit.matchedBy -eq 'appellation') { Write-Output ("[resolved] '{0}' -> {1} (by appellation)" -f $Name, $hit.name) }
    }

    if ($people.Count -eq 0) { Write-Output '(vault is empty)'; exit 0 }

    foreach ($p in $people) {
        $app = if ($p.appellation) { " ($($p.appellation))" } else { '' }
        Write-Output ("name: {0}{1}" -f $p.name, $app)
        $fields = @($p.fields)
        if ($fields.Count -gt 0) { Write-Output ("  fields: {0}" -f ($fields -join ', ')) }
        else { Write-Output '  fields: (none)' }
        if ($p.hasNotes) { Write-Output '  notes: present (not exposed to the API)' }
        Write-Output ''
    }
} catch {
    [Console]::Error.WriteLine("[error] $($_.Exception.Message)")
    exit 1
}
