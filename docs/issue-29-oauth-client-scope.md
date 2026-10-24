# Issue #29: OAuth client-scoped Gateway tool policy (draft, NOT deployed)

This is a **source-only** change for the existing `kaito-pc-agent-oauth-readonly` Supabase Edge Function. It does not change Sites, Cloudflare, database data, OAuth registrations, devices, production settings or tokens.

## Rationale / trust boundary

The verified `ctx.jwtClaims.client_id` from `withSupabase({auth:"user"})` is used **after** the existing owner-user check. It is NOT read from HTTP headers, MCP tool input, `ctx.userClaims`, or caller-provided JSON. Supabase OAuth Server documents that its JWT access tokens include `client_id`; `@supabase/server` documents `ctx.jwtClaims` as the verified raw JWT claims.

- `KAITO_PC_AGENT_SITE_OAUTH_CLIENT_ID`: the **one exact** OAuth client ID that Sites uses for the Supabase OAuth flow. **Do not guess this value.** Configure only after reading its registered client ID from the legitimate OAuth management interface.
- `KAITO_PC_AGENT_PRIVILEGED_OAUTH_CLIENT_IDS`: optional comma-separated allowlist of **other** explicitly approved OAuth client IDs for the existing full Gateway capabilities. An empty string means no privileged clients. Never add the Site ID to this list.
- If the Site ID setting is absent/malformed, the claim is absent/malformed, privileged IDs are malformed/duplicated, or the lists overlap, **all** OAuth clients are rejected (403). The code must **not** be deployed without evaluating this compatibility consequence first.
- Site client is limited to `gateway_probe`, `relay_ping`, `ping`. The `tools/list` result is filtered AND `tools/call` enforces the same policy before task orchestration, PC queue, image, GUI, file access or development command branches.
- Only explicitly allowlisted different OAuth clients retain full existing Gateway capabilities. Unknown/unregistered clients default to deny. The existing user UUID allowlist check remains required for everyone.
- This is a Gateway defense-in-depth control: it **does not** establish the authenticity of Sites identity headers or browser/MCP same-user matching. A malicious actor with an actual allowlisted privileged client's valid bearer token remains subject to that token's capabilities, so protecting/token-revoking those tokens remains important.

## Mandatory tests and review before a separate deployment approval

1. `node --test tests/oauth-client-policy.test.mjs` passes, including absent/duplicate/malformed configs, spoofed headers, Site restrictions, `task_step` denial, and dispatch guard placement.
2. `deno check gateway/oauth-pc-agent/index.ts gateway/pc-agent-device/index.ts` passes in Gateway CI.
3. Confirm that the planned Site client ID is **actually** in a verified Supabase token's `client_id` claim or official OAuth client registration. Do not log/print full JWT or identity data. No live bearer token test in this source-only PR.
4. Before any production rollout, identify whether other current OAuth clients need full functionality, confirm their **exact** IDs through official administration, and explicitly decide whether to allowlist them; avoid locking out the existing plugin unexpectedly.
5. For an eventual approval-gated rollout, configure both variables through the supported Supabase secrets/environment management interface, preserving current settings. Verify rollback, readback (names/flags only), Site tool list and direct denied `tools/call` with authorized safe test identities. **Never** confuse a mock test with actual JWT / Gateway E2E verification.
6. OAuth/Relay remain OFF; Sites production saved version 10 is unchanged. No PC ping or other command is sent by this PR. Do not enable OAuth before the separate Sites impersonation/relay security release gates are satisfied.

## Reference

- Supabase OAuth token security: https://supabase.com/docs/guides/auth/oauth-server/token-security
- Supabase server auth modes (`jwtClaims`): https://github.com/supabase/server/blob/main/docs/auth-modes.md
- Goal and release gate: Issue #29 and PR #42.
