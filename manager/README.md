# PC Agent Manager

The production Windows supervisor for the Node.js PC Agent.

## Current MVP

The Manager is a normal-user .NET 8 WinForms application and provides:

- Start / Stop / Restart
- Named Pipe health monitoring
- Agent heartbeat and queue-connectivity display
- crash recovery with exponential backoff
- crash-loop detection
- Windows Job Object containment with kill-on-manager-exit
- persistent local Emergency Stop
- system-tray operation
- optional Windows login startup under the current user
- diagnostics view and copy button
- DPAPI-encrypted device-token storage
- portable self-contained Windows build with a bundled Node.js runtime
- local Update check that consumes versioned GitHub Release assets
- SHA-256 verification and path-safe staged extraction before any switch
- transactional bootstrap that health-checks the new bundled Agent and automatically starts the previous Manager on failure

The Manager is only a supervisor. It does **not** implement Tool Registry, capability, path, risk, or remote-command authorization rules.

## Local data

Persistent state is stored under:

```text
%LOCALAPPDATA%\PcAgent\
  manager.json
  device-token.bin
  journal.sqlite
  emergency-stop.lock
  manager.log
```

`device-token.bin` is protected with Windows DPAPI for the current user. The plaintext token is passed only to the child Agent process environment and is never written into `manager.json` or logs.

## First start

1. Open `PcAgentManager.exe`.
2. On first run, the Manager automatically looks for a compatible existing PC Agent `device.json` under common local configuration roots.
3. If found, Device ID / Token are imported automatically and the token is immediately saved with Windows DPAPI.
4. Confirm the Supabase device endpoint and allowed roots only if the settings screen is shown.
5. Press **Start** if Agent auto-start is disabled.

The settings screen also has **既存Agent設定を自動検出** for a manual retry. The importer validates that the legacy configuration belongs to the expected Supabase project before accepting it.

The current personal deployment defaults the endpoint to the neutral `pc-agent-device` Edge Function. No administrator privilege is requested.

## Emergency Stop

**EMERGENCY STOP** immediately disables automatic restart and stops the Agent. The lock persists across Manager/Windows restarts.

Recovery requires pressing **Emergency Stop解除** locally in the Manager UI.

## Portable bundle

GitHub Actions produces `pc-agent-manager-win-x64` containing:

```text
PcAgentManager.exe
Runtime\node.exe
Agent\bin\pc-agent.js
Agent\src\...
SHA256SUMS.txt
```

The .NET runtime and Node.js runtime are bundled, so normal use does not require PowerShell, a separate .NET install, or a separate Node.js install.
