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
