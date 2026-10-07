# Supabase command queue

The production queue currently reuses the existing device and command tables so the old relay can keep working during migration.

The new Agent path is:

```text
OAuth read-only gateway
  -> existing command table
  -> claim_pc_agent_command_v1
  -> pc-agent-device Edge Function
  -> SupabaseQueueClient
  -> Agent Runtime / Tool Registry / Journal
  -> pc-agent-device result endpoint
  -> existing command table
```

## Device authentication

The Agent sends its existing high-entropy per-device bearer token to the `pc-agent-device` Edge Function. The function hashes the token with SHA-256 and compares it server-side against the existing device record. The service-role key remains inside Supabase only.

The Edge Function is deployed with platform JWT verification disabled because the device credential is not a Supabase user JWT. The function body performs the custom device-token verification before poll/result access.

## Compatibility

The schema migration adds command-envelope columns with defaults. Legacy command producers and the old device relay therefore continue to work while the new Agent is introduced.

No plaintext device token or Supabase service-role credential is stored in this repository.


## Queue isolation

The production database intentionally uses separate queue states for the v1 Agent:

```text
legacy worker: queued -> claimed
v1 Agent:      agent_queued -> agent_claimed
```

Both paths still finish as `completed`, `failed`, or `expired`.

This prevents an older worker and the production Agent from racing to claim the same command while migration is in progress. The legacy OAuth read-only endpoint routes the four v1 read-only tools to `agent_queued`; its legacy `ping` path remains on the old queue until that compatibility tool is replaced.


## OAuth safe-write gateway

The deployed OAuth MCP endpoint remains on its existing Supabase function slug for compatibility, and v5 now exposes three locally approved write tools:

- `create_directory`
- `write_text_file`
- `edit_text_file`

Both commands are routed to the production `agent_queued` queue and require explicit approval in the local PC Agent Manager before the Agent executes them.

`write_text_file` requires `expected_sha256` when replacing an existing file. `edit_text_file` requires the current SHA-256 and exactly one matching `old_text` occurrence before it can build the approved replacement. New files must use `expected_sha256: null`. The Agent still enforces allowed roots, sensitive-path blocking, optimistic concurrency, backup, atomic replacement, operation journaling, and read-back hash verification.

The OAuth gateway is not the final authorization authority. Local Agent policy and local Manager approval remain mandatory.


## OAuth development runner

Gateway v6 exposes `run_development_command`. The request is structured as `program + args[] + cwd + timeout_ms`; arbitrary shell strings are not accepted. The Agent remains authoritative and currently allows only Git inspection commands, `npm test`, and `node --test`. Every development command requires explicit local Manager approval.


## OAuth bounded task orchestration

Gateway v7 adds four orchestration tools:

- `task_begin`
- `task_status`
- `task_step`
- `task_finish`

A task is only a cloud-side execution budget and audit context. It does **not** grant any new Windows capability. Every `task_step` still dispatches exactly one existing Agent tool through the normal command queue. Tool Registry validation, allowed-root checks, sensitive-path rules, operation journaling, and local Manager approval remain authoritative.

Task budgets bound:

- maximum action steps
- maximum retries
- maximum total steps
- maximum duration

`observe` and `verify` phases may use read-only tools only. `act` phases must use locally governed write or development tools. A task cannot finish as `succeeded` unless its latest completed phase is a successful `verify` step.

The gateway stores only task/step audit metadata. It intentionally does not duplicate full tool arguments or full tool results in the task tables. If the same normalized failure fingerprint occurs twice consecutively, the task transitions to `blocked` and further execution is rejected.


## OAuth repository repair workflow

Gateway v8 tightens task semantics for real repository repair work:

- Observe may use ordinary read-only tools and approved Git inspection commands.
- Act may use the existing locally approved safe-write tools only.
- Verify may use ordinary read-only tools plus approved Git inspection, `npm test`, or `node --test`.
- Development Runner commands still require explicit local Manager approval.
- A successful task step records a SHA-256 fingerprint of its structured result in the task audit tables; full command output is not duplicated there.
- A task cannot finish as `succeeded` without a final successful Verify step carrying result evidence.

The Agent now treats every non-zero development command exit code as a tool failure. This makes test failure and Git validation failure visible to the task loop instead of allowing a failed command to satisfy completion criteria.


## OAuth read range contract — v8.1

The Agent now implements the range arguments already exposed by the OAuth schema for `read_text_file`:

- `offset`: non-negative byte offset, default 0
- `maxBytes`: 1..65536 bytes per call

The result includes `offset`, `bytes`, `next_offset`, and `eof` so callers can page through bounded UTF-8 text safely. The Agent still rejects files above its configured maximum text-file size and blocks sensitive paths.


## OAuth v1 ping migration — v8.2

`ping` now uses the same production v1 command path as every other Windows Agent tool:

```text
OAuth Gateway
  -> agent_queued
  -> pc-agent-device
  -> Agent Tool Registry: ping
  -> agent_claimed
  -> completed
```

The OAuth gateway no longer creates legacy `queued`/`claimed` ping commands. This removes the final runtime dependency on the old standalone `kaito-device-agent.mjs` worker.
