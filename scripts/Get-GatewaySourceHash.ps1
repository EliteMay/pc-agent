<#
.SYNOPSIS
  Prints a line-ending-insensitive SHA-256 of a gateway function source file, for comparing a
  checkout with the deployed function source obtained read-only (Supabase dashboard / connector).
.EXAMPLE
  .\scripts\Get-GatewaySourceHash.ps1 gateway\oauth-pc-agent\index.ts
  .\scripts\Get-GatewaySourceHash.ps1 -Text (Get-Content -Raw C:\Temp\deployed-index.ts)
#>
[CmdletBinding(DefaultParameterSetName = 'File')]
param(
    [Parameter(ParameterSetName = 'File', Position = 0, Mandatory = $true)][string]$Path,
    [Parameter(ParameterSetName = 'Text', Mandatory = $true)][string]$Text
)
if ($PSCmdlet.ParameterSetName -eq 'File') { $Text = Get-Content -Raw -LiteralPath $Path -Encoding UTF8 }
$normalized = $Text.Replace("`r`n", "`n").TrimEnd("`n") + "`n"
$bytes = [Text.Encoding]::UTF8.GetBytes($normalized)
$hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
Write-Output "$hash  (normalized LF, trailing newline)"
