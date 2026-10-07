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
