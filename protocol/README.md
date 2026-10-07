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
