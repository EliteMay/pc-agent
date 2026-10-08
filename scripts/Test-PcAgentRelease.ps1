<#
.SYNOPSIS
  Read-only validation of an installed or staged PC Agent Windows bundle.
.DESCRIPTION
  Validates Manager and Agent package versions, file SHA-256, bundled Node,
  and the built-in --bundle-check. Optional tests validate Windows login
  startup and Game Safety on the current local machine. Does not read or
  output device credentials, write files or registry, or start the Agent.
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
    Assert-Readiness (Test-Path -LiteralPath $manifest -PathType Leaf) 'Agent manifest present'
    Assert-Readiness (Test-Path -LiteralPath $hashes -PathType Leaf) 'Manager SHA256SUMS present'

    if (Test-Path -LiteralPath $manifest -PathType Leaf) {
        $agentVersion = (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).version
        $validAgentVersion = ($agentVersion -is [string] -and $agentVersion -match '^\d+\.\d+\.\d+$')
        Assert-Readiness $validAgentVersion 'Agent release version valid'
        if ($validAgentVersion -and (Test-Path -LiteralPath $exe -PathType Leaf)) {
            $managerVersion = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
            $versionsMatch = ($managerVersion -eq $agentVersion -or
                $managerVersion.StartsWith($agentVersion + '+', [StringComparison]::Ordinal))
            Assert-Readiness $versionsMatch 'Manager and Agent versions match'
        }
    }

    if ((Test-Path -LiteralPath $hashes -PathType Leaf) -and
        (Test-Path -LiteralPath $exe -PathType Leaf)) {
        $hashText = Get-Content -LiteralPath $hashes -Raw
        $checksumMatch = [regex]::Match(
            $hashText.Trim(),
            '(?im)^([a-f0-9]{64})\s+\*?PcAgentManager\.exe\s*$')
        Assert-Readiness $checksumMatch.Success 'Manager checksum entry present'
        if ($checksumMatch.Success) {
            $actual = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
            $hashMatches = [string]::Equals(
                $actual, $checksumMatch.Groups[1].Value,
                [StringComparison]::OrdinalIgnoreCase)
            Assert-Readiness $hashMatches 'Manager binary SHA-256 matches'
        }
    }

    if (Test-Path -LiteralPath $node -PathType Leaf) {
        $nodeVersion = & $node --version
        $nodeWorks = ($LASTEXITCODE -eq 0 -and
            $nodeVersion -match '^v\d+\.\d+\.\d+$')
        Assert-Readiness $nodeWorks 'Bundled Node executes'
    }

    if (Test-Path -LiteralPath $exe -PathType Leaf) {
        $process = Start-Process -FilePath $exe -ArgumentList '--bundle-check' -Wait -PassThru
        Assert-Readiness ($process.ExitCode -eq 0) 'Manager bundle-check exits 0'
    }

    if ($RequireLoginStartup -or $RequireGameSafety) {
        $configPath = Join-Path $env:LOCALAPPDATA 'PcAgent\manager.json'
        $configExists = Test-Path -LiteralPath $configPath -PathType Leaf
        Assert-Readiness $configExists 'Installed config exists'
        if ($configExists) {
            $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json

            if ($RequireLoginStartup) {
                Assert-Readiness ($config.auto_start_manager -eq $true) 'Manager login auto-start configured'
                $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
                $startup = Get-ItemProperty -Path $runKey -Name 'PC Agent Manager' -ErrorAction SilentlyContinue
                $expected = '"' + $exe + '" --background'
                $correctEntry = ($null -ne $startup -and
                    [string]::Equals([string]$startup.'PC Agent Manager',
                        $expected, [StringComparison]::OrdinalIgnoreCase))
                Assert-Readiness $correctEntry 'HKCU startup points at this Manager'
            }

            if ($RequireGameSafety) {
                Assert-Readiness ($config.pause_agent_during_protected_games -eq $true) 'VALORANT Game Safety enabled'
                Assert-Readiness ($config.auto_start_agent -eq $true) 'Agent supervised auto-start enabled'
            }
        }
    }
}
catch {
    # Do not print raw config or exception messages that may include private data.
    $failures.Add('Unexpected verifier error')
    Write-Output ('FAIL verifier exception type: ' + $_.Exception.GetType().Name)
}

Write-Output ("Release readiness: {0} checks passed, {1} failed." -f $passed, $failures.Count)
if ($failures.Count -gt 0) { exit 1 }
exit 0
