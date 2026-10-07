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
- `manager/` — C#/.NET production supervisor and Windows UI.
- `protocol/` — shared command and IPC protocol documentation.
- `docs/` — architecture and security specifications.
- `tests/` — cross-component tests as they are added.

## Current implementation

The first production slice is the Agent safety foundation:

- fail-closed Tool Registry
- capability constants
- Windows allowed-root lexical boundary checks
- filesystem-backed canonical path enforcement with `realpathSync.native`
- junction / symlink / reparse-point escape rejection
- nearest-existing-parent resolution for new paths
- write-time parent revalidation for TOCTOU defense
- Windows reserved-name / alternate-data-stream rejection
- sensitive-path detection
- command envelope validation
- `operation_id` and `expires_at` validation
- persistent SQLite operation journal
- duplicate logical-operation suppression
- interrupted operations recover as `UNKNOWN_OUTCOME`
- SHA-256 result fingerprints without storing raw tool output
- four bounded read-only tools: `system_info`, `list_directory`, `read_text_file`, `list_processes`
- validated command runtime: envelope -> Tool Registry -> operation journal -> tool execution
- authenticated Supabase device queue client and result transport
- cloud command envelope fields: device ID, tool version, protocol version, operation ID, expiry
- neutral `pc-agent-device` Supabase Edge Function for device polling/results
- production .NET 8 Windows Manager with tray UI, supervision, heartbeat, crash recovery, Job Object containment, encrypted token storage, and Emergency Stop
- portable self-contained Windows Manager + bundled Node.js Agent artifact
- local approval broker exposed to the Manager over supervisory Named Pipe IPC
- Manager approval dialog for PC-changing operations
- confirmed `create_directory` safe-write tool
- confirmed `write_text_file` with expected SHA-256, backup, atomic temp-file replacement, and read-back hash verification
- confirmed `edit_text_file` that replaces exactly one expected UTF-8 text occurrence with the same hash/backup/verification protections
- structured v0.5 Development Runner with shell disabled, stdin disabled, bounded timeout/output, sanitized environment, allowed-root cwd enforcement, and full-tree timeout termination
- development subcommand policy: git inspection only, npm test, and node --test; all development execution requires explicit local approval
- Windows CI

The journal prevents a repeated `operation_id` from executing twice, even after process restart. A process that dies while an operation is `RUNNING` causes that record to become `UNKNOWN_OUTCOME` on the next startup, so the Agent fails closed instead of blindly retrying.

The first read-only tool set is intentionally narrow:

- `system_info` returns bounded OS/runtime facts and omits username/hostname.
- `list_directory` canonicalizes the directory, refuses root escapes, does not follow child links, filters sensitive names, and caps returned entries.
- `read_text_file` canonicalizes the file path, rejects sensitive paths, binary/non-UTF-8 content, non-files, and files above the configured byte limit.
- `list_processes` invokes the fixed Windows `System32\\tasklist.exe` binary without a shell and returns only image name + PID.

The production Supabase queue schema and the neutral `pc-agent-device` Edge Function are now wired to the Agent runtime. The existing relay tables remain temporarily in use for backward compatibility while new code and endpoints use neutral names.

Filesystem writes are now limited to the three v0.4 safe-write tools and require explicit local approval in the Manager. Arbitrary user-supplied command execution remains intentionally **not implemented**. v0.5 only permits structured, policy-checked development commands.

Filesystem access must use the canonical path guards, not the lexical helper alone. For new files, callers must resolve the nearest existing parent and call write-time revalidation immediately before creating or replacing the file. Write tools remain restricted to configured allowed roots, deny sensitive paths, and are gated by explicit local approval. Existing-file replacement additionally requires the caller to provide the current SHA-256 hash.

See `docs/superpowers/specs/2026-10-07-pc-agent-design.md` for the system design.
