<#
.SYNOPSIS
  Read-only check that the Agent files inside a PC Agent Windows bundle are byte-identical
  to the Agent source of a given git checkout.
.DESCRIPTION
  Complements Test-PcAgentRelease.ps1 (version, Manager SHA-256, bundle-check). Compares
  Agent\src, Agent\bin and Agent\package.json of the bundle with agent\src, agent\bin and
  agent\package.json of SourceRoot by SHA-256. Writes nothing, starts nothing, reads no
  credentials. Exit code 1 on any difference.
.EXAMPLE
  .\scripts\Compare-BundleToSource.ps1 -BundleRoot C:\Temp\candidate -SourceRoot .
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BundleRoot,
    [Parameter(Mandatory = $true)][string]$SourceRoot
)
$ErrorActionPreference = 'Stop'
$bundleAgent = Join-Path ([IO.Path]::GetFullPath($BundleRoot)) 'Agent'
$sourceAgent = Join-Path ([IO.Path]::GetFullPath($SourceRoot)) 'agent'
if (-not (Test-Path -LiteralPath $bundleAgent -PathType Container)) { throw 'Bundle has no Agent directory.' }
if (-not (Test-Path -LiteralPath $sourceAgent -PathType Container)) { throw 'Source has no agent directory.' }

function Get-HashMap([string]$root, [string[]]$parts) {
    $map = @{}
    foreach ($part in $parts) {
        $path = Join-Path $root $part
        if (Test-Path -LiteralPath $path -PathType Leaf) { $items = @(Get-Item -LiteralPath $path) }
        elseif (Test-Path -LiteralPath $path -PathType Container) { $items = @(Get-ChildItem -LiteralPath $path -Recurse -File) }
        else { continue }
        foreach ($item in $items) {
            $relative = $item.FullName.Substring($root.Length).TrimStart('\', '/').Replace('\', '/')
            # Text files are compared with CRLF folded to LF: the release runner checks out with CRLF,
            # git archive emits LF. Binary files (none expected) are hashed as-is.
            $bytes = [IO.File]::ReadAllBytes($item.FullName)
            if ($item.Extension -in '.js', '.ps1', '.json', '.md') {
                $text = [Text.Encoding]::UTF8.GetString($bytes).Replace("`r`n", "`n")
                $bytes = [Text.Encoding]::UTF8.GetBytes($text)
            }
            $map[$relative] = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes))
        }
    }
    return $map
}
$parts = @('src', 'bin', 'package.json')
$bundle = Get-HashMap $bundleAgent $parts
$source = Get-HashMap $sourceAgent $parts
$missing = @($source.Keys | Where-Object { -not $bundle.ContainsKey($_) })
$extra = @($bundle.Keys | Where-Object { -not $source.ContainsKey($_) })
$differ = @($source.Keys | Where-Object { $bundle.ContainsKey($_) -and $bundle[$_] -ne $source[$_] })
Write-Output "Compared files: source=$($source.Count) bundle=$($bundle.Count)"
foreach ($f in $missing) { Write-Output "MISSING in bundle: $f" }
foreach ($f in $extra) { Write-Output "EXTRA in bundle: $f" }
foreach ($f in $differ) { Write-Output "DIFFERENT: $f" }
if ($missing.Count + $extra.Count + $differ.Count -eq 0 -and $source.Count -gt 0) {
    Write-Output 'PASS Agent files in the bundle are identical to the source checkout.'
    exit 0
}
Write-Output 'FAIL Bundle Agent files differ from the source checkout.'
exit 1
