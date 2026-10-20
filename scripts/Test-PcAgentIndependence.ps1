<#
.SYNOPSIS
  Read-only preflight: is the installed PC Agent running on its own, without Desktop Commander?
.DESCRIPTION
  Checks that the Manager and its Agent are running from one installed bundle, that the Agent was
  started by the Manager (not by Desktop Commander), that Game Safety is enabled, and - with
  -RequireDesktopCommanderStopped - that no Desktop Commander Remote process exists and the Manager
  is not configured to start one. Reads manager.json booleans only; never reads device-token.bin,
  never prints command lines, writes nothing, starts and stops nothing.
.EXAMPLE
  .\scripts\Test-PcAgentIndependence.ps1 -RequireDesktopCommanderStopped
#>
[CmdletBinding()]
param(
    [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'PcAgent'),
    [switch]$RequireDesktopCommanderStopped
)
$ErrorActionPreference = 'Stop'
$failures = New-Object 'System.Collections.Generic.List[string]'
$warnings = New-Object 'System.Collections.Generic.List[string]'
$passed = 0
function Assert-Check([bool]$ok, [string]$description) {
    if ($ok) { $script:passed++; Write-Output "PASS $description" }
    else { $script:failures.Add($description); Write-Output "FAIL $description" }
}
function Add-Warning([string]$text) { $script:warnings.Add($text); Write-Output "WARN $text" }
$dcPattern = 'desktop-?commander|wonderwhy-er'

$processes = @(Get-CimInstance Win32_Process)
$byId = @{}
foreach ($p in $processes) { $byId[[int]$p.ProcessId] = $p }

$managers = @($processes | Where-Object { $_.Name -eq 'PcAgentManager.exe' -and $_.ExecutablePath })
Assert-Check ($managers.Count -eq 1) 'Exactly one PcAgentManager.exe is running'
if ($managers.Count -eq 1) {
    $manager = $managers[0]
    $bundle = Split-Path -Parent $manager.ExecutablePath
    Assert-Check ($bundle.StartsWith($DataRoot, [StringComparison]::OrdinalIgnoreCase)) 'Manager runs from the installed data root'
    $agents = @($processes | Where-Object {
        $_.Name -eq 'node.exe' -and [int]$_.ParentProcessId -eq [int]$manager.ProcessId -and
        $_.CommandLine -and $_.CommandLine -match 'pc-agent\.js'
    })
    Assert-Check ($agents.Count -eq 1) 'Exactly one Agent (pc-agent.js) is a direct child of the Manager'
    if ($agents.Count -eq 1) {
        $agentProcess = $agents[0]
        $agentRuntime = Join-Path $bundle 'Runtime\node.exe'
        Assert-Check ($agentProcess.ExecutablePath -eq $agentRuntime) 'Agent uses the bundled Node runtime of the same bundle'
        $chain = @(); $cursor = $agentProcess
        while ($cursor -and $chain.Count -lt 12) {
            $chain += $cursor
            $parentId = [int]$cursor.ParentProcessId
            $cursor = if ($byId.ContainsKey($parentId)) { $byId[$parentId] } else { $null }
        }
        $dcAncestors = @($chain | Where-Object { $_.CommandLine -and $_.CommandLine -match $dcPattern })
        Assert-Check ($dcAncestors.Count -eq 0) 'No Desktop Commander process in the Agent ancestry'
    }
    $manifest = Join-Path $bundle 'Agent\package.json'
    if (Test-Path -LiteralPath $manifest) {
        $agentVersion = (Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json).version
        Assert-Check ((Split-Path -Leaf $bundle) -eq $agentVersion) "Bundle folder name matches Agent version ($agentVersion)"
    }
}

$configPath = Join-Path $DataRoot 'manager.json'
Assert-Check (Test-Path -LiteralPath $configPath) 'manager.json exists'
if (Test-Path -LiteralPath $configPath) {
    $config = Get-Content -Raw -LiteralPath $configPath -Encoding UTF8 | ConvertFrom-Json
    Assert-Check ($config.pause_agent_during_protected_games -eq $true) 'Game Safety (pause during protected games) is enabled'
    Assert-Check ($config.auto_start_agent -eq $true) 'Agent auto-start is enabled'
    $managesDc = ($config.manage_desktop_commander_remote -eq $true)
    if ($RequireDesktopCommanderStopped) {
        Assert-Check (-not $managesDc) 'Manager is NOT configured to start Desktop Commander Remote'
    }
    elseif ($managesDc) { Add-Warning 'Manager is configured to start Desktop Commander Remote (optional Game Safety helper)' }
}

$dcProcesses = @($processes | Where-Object { $_.CommandLine -and $_.CommandLine -match $dcPattern -and $_.Name -ne 'powershell.exe' })
if ($RequireDesktopCommanderStopped) { Assert-Check ($dcProcesses.Count -eq 0) 'No Desktop Commander process is running' }
elseif ($dcProcesses.Count -gt 0) { Add-Warning "Desktop Commander processes running: $($dcProcesses.Count)" }

$gameRunning = @($processes | Where-Object { $_.Name -in 'VALORANT.exe', 'VALORANT-Win64-Shipping.exe' })
if ($gameRunning.Count -gt 0) { Add-Warning 'A protected game is running; the Agent is expected to be paused' }

$logPath = Join-Path $DataRoot 'manager.log'
if (Test-Path -LiteralPath $logPath) {
    $recent = @(Get-Content -LiteralPath $logPath -Tail 400 | Where-Object { $_ -match '"event":"queue_error"' })
    $cutoff = (Get-Date).ToUniversalTime().AddMinutes(-10)
    $fresh = @($recent | Where-Object { [DateTimeOffset]::Parse(($_ -split "`t")[0]).UtcDateTime -gt $cutoff })
    if ($fresh.Count -gt 0) { Add-Warning "Agent reported $($fresh.Count) queue error(s) in the last 10 minutes" }
}

Write-Output "Independence preflight: $passed passed, $($failures.Count) failed, $($warnings.Count) warnings."
if ($failures.Count -gt 0) { exit 1 }
