# Protocol

Protocol version: `1`.

Cloud commands use this v1 envelope:

```json
{
  "command_id": "22222222-2222-4222-8222-222222222222",
  "operation_id": "33333333-3333-4333-8333-333333333333",
  "device_id": "11111111-1111-4111-8111-111111111111",
  "tool": "system_info",
  "tool_version": "1",
  "protocol_version": 1,
  "created_at": "2026-10-07T00:00:00.000Z",
  "expires_at": "2026-10-07T00:01:00.000Z",
  "args": {},
  "request_metadata": {}
}
```

`command_id` identifies one concrete queue delivery.
`operation_id` identifies the logical action across retries or re-deliveries.
`device_id` binds the envelope to the authenticated Windows device.
`tool_version` must match the locally registered Tool Registry version before execution.

Expired, malformed, wrong-version, wrong-device, and unknown-tool commands are rejected before local execution.

## Queue transport

The authenticated device transport uses two HTTPS operations:

```text
POST /poll
  -> zero or one command envelope

POST /result
  -> command_id + operation_id
  -> succeeded + structured result
     or
     failed + structured error
```

The device bearer token is validated only by the Supabase device Edge Function. The Supabase service-role key never leaves Supabase.

A result is accepted only while the exact command is still `claimed` by the authenticated device. Expired/stale commands are not overwritten by a late result.

## Duplicate operation handling

The local Agent journal treats `operation_id` as the idempotency key.

- First sighting: create `RUNNING`, then execute.
- Success: transition to `SUCCEEDED` and store only a SHA-256 result fingerprint.
- Tool failure: transition to `FAILED` with an error code.
- Duplicate `operation_id`: do not execute again.
- Agent restart with a leftover `RUNNING` record: transition it to `UNKNOWN_OUTCOME` and do not auto-retry.

If a duplicate delivery arrives after the original result is no longer available locally, the Agent reports `DUPLICATE_OPERATION` instead of re-running the tool.

This intentionally prefers a safe unknown/duplicate state over potentially repeating a side effect.


## v0.7 task orchestration metadata

Task orchestration is a gateway concern and does not change protocol version 1. A task step still produces one ordinary command envelope. The gateway adds bounded trace metadata in `request_metadata`:

```json
{
  "task_id": "44444444-4444-4444-8444-444444444444",
  "task_step_id": "verify-build",
  "task_step_run_id": "55555555-5555-4555-8555-555555555555",
  "task_phase": "verify",
  "task_attempt": 1
}
```

The Agent treats this metadata as audit context only. It does not use task metadata to authorize a tool. Tool Registry, capability policy, path policy, command expiry, operation deduplication, and local approval are enforced exactly as for non-task commands.

Gateway task state enforces bounded execution and blocks repeated identical failure fingerprints. A task may be marked `succeeded` only after a successful `verify` phase.


## v0.8 verification evidence

Successful orchestrated task steps persist only a SHA-256 fingerprint of the structured tool result:

```text
result_fingerprint = sha256(JSON structured result)
```

Full stdout, stderr, file contents, and other tool results remain in the existing command result path and are intentionally not copied into task audit tables.

For repository workflows, a development command with a non-zero exit code is a failed Agent tool execution. Therefore a failing `npm test`, `node --test`, or Git validation command cannot count as successful verification.
