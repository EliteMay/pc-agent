# Protocol

Protocol version: `1`.

Cloud commands use an envelope containing at minimum:

```json
{
  "command_id": "cmd-...",
  "operation_id": "op-...",
  "tool": "system_info",
  "protocol_version": 1,
  "created_at": "2026-10-07T00:00:00.000Z",
  "expires_at": "2026-10-07T00:01:00.000Z",
  "args": {}
}
```

`command_id` identifies one concrete transmission/attempt.
`operation_id` identifies the logical operation across retries.

Expired, malformed, and unsupported-version commands are rejected before tool lookup or execution.

## Duplicate operation handling

The local Agent journal treats `operation_id` as the idempotency key.

- First sighting: create `RUNNING`, then execute.
- Success: transition to `SUCCEEDED` and store only a SHA-256 result fingerprint.
- Tool failure: transition to `FAILED` with an error code.
- Duplicate `operation_id`: do not execute again.
- Agent restart with a leftover `RUNNING` record: transition it to `UNKNOWN_OUTCOME` and do not auto-retry.

This intentionally prefers a safe unknown state over potentially repeating a side effect.
