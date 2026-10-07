# PC Agent

Windows PC Agent for controlled, auditable actions initiated through ChatGPT and a cloud gateway.

## Architecture

```text
ChatGPT
   |
   v
Supabase OAuth Gateway
   |
   v
Command Queue
   |
   v
Node.js Agent  <-- security boundary
   ^
   | Named Pipe (supervisory only)
   v
C#/.NET Manager
```

The Agent is the final authorization boundary. The Manager supervises the Agent but does not make capability, path, risk, or tool-authorization decisions.

## Repository layout

- `agent/` — Node.js worker and security boundary.
- `manager/` — C#/.NET supervisor. Implementation follows after the Agent safety foundation.
- `protocol/` — shared command and IPC protocol documentation.
- `docs/` — architecture and security specifications.
- `tests/` — cross-component tests as they are added.

## Current implementation

The first production slice is the Agent safety foundation:

- fail-closed Tool Registry
- capability constants
- Windows allowed-root lexical boundary checks
- sensitive-path detection
- command envelope validation
- `operation_id` and `expires_at` validation
- persistent SQLite operation journal
- duplicate logical-operation suppression
- interrupted operations recover as `UNKNOWN_OUTCOME`
- SHA-256 result fingerprints without storing raw tool output
- Windows CI

The journal prevents a repeated `operation_id` from executing twice, even after process restart. A process that dies while an operation is `RUNNING` causes that record to become `UNKNOWN_OUTCOME` on the next startup, so the Agent fails closed instead of blindly retrying.

Filesystem writes and arbitrary command execution are intentionally **not implemented yet**.

Before write tools are enabled, path checks will also canonicalize existing paths with the Windows filesystem (`realpath`) and defend against junction/reparse-point escapes.

See `docs/superpowers/specs/2026-10-07-pc-agent-design.md` for the system design.
