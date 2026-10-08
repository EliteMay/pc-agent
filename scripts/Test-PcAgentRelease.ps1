<#
.SYNOPSIS
  Read-only verifier for an already built PC Agent Manager Windows bundle.
.DESCRIPTION
  Validates package structure, matching Manager/Agent version, SHA-256,
  bundled Node runtime and the Manager's own --bundle-check contract.

  Optional local checks validate HKCU login startup and protective Game
  Safety defaults. Does not read device tokens, send commands, start an Agent,
  install an update, or modify configuration/registry files.
.EXAMPLE
  .\scripts\Test-PcAgentRelease.ps1 -BundleRoot "$env:LOCALAPPDATA\PcAgent\releases\0.11.0" -RequireLoginStartup -RequireGameSafety
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BundleRoot,

    [switch]$RequireLoginStartup,
    [switch]$RequireGameSafety
)

$ErrorActionPreference = 'Stop'
$failures = New-Object 'System.Collections.Generic.List[string]'
$passed = 0

function Assert-Readiness([bool]$condition, [string]$description) {
    if ($condition) {
        $script:passed++
        Write-Output "PASS $description"
    }
    else {
        $script:failures.Add($description)
        Write-Output "FAIL $description"
    }
}

try {
    $root = [System.IO.Path]::GetFullPath($BundleRoot)
    $exe = Join-Path $root 'PcAgentManager.exe'
    $node = Join-Path $root 'Runtime\node.exe'
    $agent = Join-Path $root 'Agent\bin\pc-agent.js'
    $manifest = Join-Path $root 'Agent\package.json'
    $hashes = Join-Path $root 'SHA256SUMS.txt'

    Assert-Readiness (Test-Path -LiteralPath $exe -PathType Leaf) 'Manager executable present'
    Assert-Readiness (Test-Path -LiteralPath $node -PathType Leaf) 'Bundled Node executable present'
    Assert-Readiness (Test-Path -LiteralPath $agent -PathType Leaf) 'Agent entrypoint present'
    Assert-Readiness (Test-Path -LiteralPath $manifest -PathType Leaf) 'Agent package manifest present'
    Assert-Readiness (Test-Path -LiteralPath $hashes -PathType Leaf) 'Manager SHA256SUMS present'

    if (Test-Path -LiteralPath $manifest -PathType Leaf) {
        $agentVersion = (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).version
        $validAgentVersion = $agentVersion -is [string] -and
            $agentVersion -match '^\d+\.\d+\.\d+$'
        Assert-Readiness $validAgentVersion 'Agent version uses a valid release number'

        if ($validAgentVersion -and (Test-Path -LiteralPath $exe -PathType Leaf)) {
            $managerVersion = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
            Assert-Readiness ($managerVersion -eq $agentVersion -or
                $managerVersion.StartsWith($agentVersion + '+', [StringComparison]::Ordinal))
                'Manager and Agent release versions match'
        }
    }

    if ((Test-Path -LiteralPath $hashes -PathType Leaf) -and
        (Test-Path -LiteralPath $exe -PathType Leaf)) {
        $match = [regex]::Match(
            (Get-Content -LiteralPath $hashes -Raw).Trim(),
            '(?im)^([a-f0-9]{64})\s+\*?PcAgentManager\.exe\s*$')
        Assert-Readiness $match.Success 'Checksum manifest has a single Manager SHA-256 entry'
        if ($match.Success) {
            $actual = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
            Assert-Readiness ([string]::Equals(
                $actual, $match.Groups[1].Value,
                [StringComparison]::OrdinalIgnoreCase)) 'Manager binary checksum matches'
        }
    }

    if (Test-Path -LiteralPath $node -PathType Leaf) {
        $nodeVersion = & $node --version
        Assert-Readiness ($LASTEXITCODE -eq 0 -and
            $nodeVersion -match '^v\d+\.\d+\.\d+$')
            'Bundled Node runtime executes'
    }

    if (Test-Path -LiteralPath $exe -PathType Leaf) {
        $check = Start-Process -FilePath $exe -ArgumentList '--bundle-check' -Wait -PassThru
        Assert-Readiness ($check.ExitCode -eq 0) 'Manager --bundle-check passed'
    }

    if ($RequireLoginStartup -or $RequireGameSafety) {
        $configPath = Join-Path $env:LOCALAPPDATA 'PcAgent\manager.json'
        $exists = Test-Path -LiteralPath $configPath -PathType Leaf
        Assert-Readiness $exists 'Installed Manager config present'

        if ($exists) {
            $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
            if ($RequireLoginStartup) {
                Assert-Readiness ($config.auto_start_manager -eq $true)
                    'Manager login auto-start setting enabled'
                $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
                $registry = Get-ItemProperty -Path $runKey -Name 'PC Agent Manager' -ErrorAction SilentlyContinue
                $expected = '"' + $exe + '" --background'
                Assert-Readiness ($null -ne $registry -and
                    [string]::Equals([string]$registry.'PC Agent Manager',
                        $expected, [StringComparison]::OrdinalIgnoreCase))
                    'HKCU login entry points to this installed Manager'
            }
            if ($RequireGameSafety) {
                Assert-Readiness ($config.pause_agent_during_protected_games -eq $true)
                    'VALORANT Game Safety setting enabled'
                Assert-Readiness ($config.auto_start_agent -eq $true)
                    'Agent starts under Manager supervision'
            }
        }
    }
}
catch {
    # Deliberately report exception type rather than secrets from input,
    # logs, or a configuration file's original error message.
    $failures.Add('Unexpected verifier error: ' + $_.Exception.GetType().Name)
    Write-Output ('FAIL verifier exception: ' + $_.Exception.GetType().Name)
}

Write-Output ("Release readiness: {0} checks passed, {1} failed." -f
    $passed, $failures.Count)
if ($failures.Count -ne 0) { exit 1 }
exit 0
