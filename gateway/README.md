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
