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
- seven bounded read-only tools: `ping`, `system_info`, `list_directory`, `read_text_file`, `find_paths`, `search_text`, `list_processes`
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
- transactional v0.6 Manager updater using GitHub Releases, SHA-256 verification, safe ZIP extraction, staged bundle-check, new-Agent health validation, and automatic rollback to the previous Manager when verification fails
- bounded v0.7 task orchestration in the OAuth gateway: task budgets, observe/act/verify phases, per-step trace metadata, retry caps, repeated-failure blocking, and verify-before-success completion
- v0.8 repository-repair verification: non-zero development exits fail the operation, Git inspection is phase-aware, tests can be used as Verify steps with local approval, and successful step results are represented by SHA-256 evidence fingerprints
- v0.8.1 read_text_file range contract: Agent supports gateway-advertised offset/maxBytes with next_offset/eof pagination metadata
- v0.8.2 legacy worker retirement: ping is a first-class Agent Tool Registry operation on the v1 queue and the standalone legacy worker/startup launcher are retired
- v0.8.3 v1-only queue: legacy `queued`/`claimed` states and `claim_kaito_pc_command` are removed from production; old Edge Function slugs return a 410 retirement response
- v0.9 workspace discovery: bounded `find_paths` and `search_text` tools let ChatGPT locate projects/code under allowed roots without Desktop Commander; dependency/sensitive/link traversal remains blocked
- v0.10 Game Safety: Manager detects the VALORANT game process by name only, pauses the Agent while the game is running, and restores it afterward only when it was previously intended to run
- v0.11 unified Game Safety: Manager can optionally supervise Desktop Commander Remote, stop only its identified remote process tree during VALORANT, and restore it afterward; the old PowerShell watchdog is no longer required on configured PCs
- Windows CI

The journal prevents a repeated `operation_id` from executing twice, even after process restart. A process that dies while an operation is `RUNNING` causes that record to become `UNKNOWN_OUTCOME` on the next startup, so the Agent fails closed instead of blindly retrying.

The read-only tool set is intentionally narrow:

- `ping` returns a bounded v1 connectivity result and accepts no arguments.
- `system_info` returns bounded OS/runtime facts and omits username/hostname.
- `list_directory` canonicalizes the directory, refuses root escapes, does not follow child links, filters sensitive names, and caps returned entries.
- `read_text_file` canonicalizes the file path, rejects sensitive paths, binary/non-UTF-8 content, non-files, and files above the configured byte limit.
- `find_paths` performs bounded recursive name search, skips sensitive paths/common dependency metadata, and never follows links.
- `search_text` performs bounded literal search in UTF-8 files, revalidates each path before opening it, and skips sensitive, binary, oversized, dependency, and linked content.
- `list_processes` invokes the fixed Windows `System32\\tasklist.exe` binary without a shell and returns only image name + PID.

The production Supabase command table and the neutral `pc-agent-device` Edge Function are wired exclusively to the v1 Agent queue states. Historical completed/failed rows remain for audit, but new legacy `queued`/`claimed` states are rejected and the legacy claim RPC is removed.

Filesystem writes are now limited to the three v0.4 safe-write tools and require explicit local approval in the Manager. Arbitrary user-supplied command execution remains intentionally **not implemented**. v0.5 only permits structured, policy-checked development commands.

Filesystem access must use the canonical path guards, not the lexical helper alone. For new files, callers must resolve the nearest existing parent and call write-time revalidation immediately before creating or replacing the file. Write tools remain restricted to configured allowed roots, deny sensitive paths, and are gated by explicit local approval. Existing-file replacement additionally requires the caller to provide the current SHA-256 hash.

See `docs/superpowers/specs/2026-10-07-pc-agent-design.md` for the system design.
