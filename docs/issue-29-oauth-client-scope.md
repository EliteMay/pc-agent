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

## 2026-10-24 independent second-pass compatibility audit (read-only evidence)

The following observations were obtained via read-only Supabase auth catalog queries and the official connected Plugin Creator metadata. **This review did not authenticate using OAuth, and it did not read or print OAuth client IDs, secrets, bearer tokens or other identity values.**

| Evidence | Result | Interpretation / limit |
| --- | --- | --- |
| `auth.oauth_clients` aggregate | 3 registered (2 public, 1 confidential) | Registration is not evidence of a working token or active session. |
| Callback categories | 1 client has a `chatgpt.site` redirect; 0 have a `workers.dev` redirect | One confidential registration is a **candidate** for the Site's OAuth flow; identity and runtime behavior remain unverified. Cloudflare callback registration is still missing. |
| Private legacy Plugin `kaito-pc-agent-oauth-readonly-v2` v0.3.0 | Manifest has `mcp.json` / `.mcp.json` and direct Supabase URL | It is distinct from the Sites Chrome plugin; don't assume they share an OAuth client ID. |
| Private Sites Plugin (v1.0.0) | Site-backed, fixed diagnostic; Supabase/PC link not active | Its existing successful `gateway_probe` does **not** demonstrate a signed Supabase client token. |
| Active Supabase OAuth Edge Function | v15 source matched the current GitHub `main` before this PR | PR code is **not deployed** and does not yet gate any live request. |
| GitHub Gateway CI on PR #47 initial head | Node policy test and `deno check` succeeded after TS type fix | CI success is not authenticated integration or deployment verification. |

### Compatibility decision: BLOCK DEPLOY, not a design rejection

- **Site client registration must be uniquely attributed**, using the official OAuth registration and Site's saved OAuth client configuration, not merely matching a redirect domain. Keep the actual ID out of the public repository, issue comments and logs.
- **Do not automatically grant privileged capabilities to both existing public OAuth registrations.** First prove which (if any) belongs to the prior private Plugin, what operations must remain supported, and whether an actual valid token contains a matching `client_id`. An unidentified client stays denied.
- **Do not deploy without configuring the exact approved identifiers.** With no `KAITO_PC_AGENT_SITE_OAUTH_CLIENT_ID`, all authenticated Gateway clients fail closed; this is a known potential legacy Plugin regression, not a rollout-ready release.
- The Site client cap to `gateway_probe` / `relay_ping` / `ping` is **stage 1 only**. To meet Issue #29, the later capture/GUI phases require deliberately scoped escalation with separate local approvals and fresh security tests; simply removing this deny gate would undo the defense.
- The Cloudflare callback redirect is not in the observed OAuth registry. **Never** bypass the existing callback/log/Relay gate by silently switching to a direct Site callback.
- The Sites header overwrite and browser/MCP owner identity are still unverified. `client_id` authorization is defense in depth, not proof of either.

### Remaining approval-gated live validation

1. Confirm exact Site and legacy OAuth client registrations through official management readback without exposing values. Do not assign any unknown client full capabilities.
2. On a safe test token, confirm only **boolean** checks that the verified JWT claim exists and matches the intended client, without revealing the token or claim.
3. In a separately approved deployment only, assert `tools/list` is reduced for the Site client and that direct `tools/call` for `task_step`, `capture_notepad` and `notepad_gui` is rejected before queue creation. The approved legacy client's existing function must remain intact.
4. Confirm rollback/readback and local approval controls. Do not send PC commands in this audit or enable OAuth/Relay.

## 2026-10-24 exact Sites callback URL matching (read-only)

An additional read-only query against `auth.oauth_clients` tested only aggregate booleans against the **exact currently published Site host** (no client ID, token, redirect URI list, or secret was read into the public report):

- **Exactly 1 confidential OAuth client** has a registered redirect URI containing `kaito-pc-agent-web-bridge.kaito2526.chatgpt.site`.
- **0 public clients** have a registered redirect URI containing that hostname.
- **0 clients** have a registered `workers.dev` redirect URI.

This narrows the likely Sites OAuth registration to one record, **but is not proof that deployed Sites saved-v10 actually uses its `client_id`**. This chat's available management tools expose only the connected Site plugin wrapper and a fixed probe, not the hosted Site source or secure configuration readback. Comparing the Site's actual OAuth client setting to the registration must take place via its formal Site management interface. Avoid posting raw client IDs into public GitHub logs/issues.

Release decision unchanged: **Draft only, no deploy, no OAuth/Relay activation, no PC actions**.

## 2026-10-24 OAuth consent compatibility evidence and Site access boundary

Read-only `auth.oauth_clients` / `auth.oauth_consents` aggregates, with **no raw client IDs, consent user IDs or credentials output**:

| Client group | Registered clients | Recorded consent rows |
| --- | ---: | ---: |
| Confidential, exact Sites callback hostname match | 1 | 0 |
| Public, no Sites callback match | 2 | 2 |

**Interpretation:** Zero consent records for the candidate do not prove no token was ever issued, and existing public-client consent records do not prove current sessions or tokens are valid. However they provide a concrete **legacy compatibility regression risk**: deploying fail-closed PR #47 with only the Site client configured could cut off authorized previous Plugin workflows. Do not infer consent->plugin mapping without authoritative client configuration.

Connected private Plugin Creator metadata confirmed the Sites bridge plugin is only a fixed diagnostic wrapper; its manifest contains no OAuth client ID. The owned legacy Private Plugin's `mcp.json`/.mcp.json connect directly to Supabase, but also do not identify the OAuth client registration with sufficient certainty. The available browser tab reader refused access under host security policy; that restriction must **not** be bypassed or replaced with CDP/raw navigation. The Library's Site artifact metadata currently reports `source_version_number=10` but does not expose hosted Site source or server-side secrets/settings.

**Action once formal Sites management is available:** compare the actual OAuth client ID in the saved-v10 server-only configuration against the one and only Supabase confidential client with the exact Sites callback host. Perform the comparison privately in that management session and publish only `match/mismatch/missing`, without copying IDs or tokens into GitHub or chat. If no formal readback exists, leave `unverified` rather than inferring a match.

For each legacy client, separately assess current consent/registration and the minimal capabilities required before configuring `KAITO_PC_AGENT_PRIVILEGED_OAUTH_CLIENT_IDS`. Do not automatically grant both public clients full access.

## 2026-10-24 source-only bootstrap readiness follow-up

- The available past non-public registration history confirms that a dedicated **confidential** Sites OAuth client was registered on **2026-10-09** and its ID was entered into Hosted Secrets without revealing values to chat/GitHub. However no independent, retrievable value-equality receipt or legacy Plugin registration map was found in past conversation summaries or accessible private Library records. Therefore **the current masked Secret-to-client ID match remains unverified**; avoid repetitive secret readback requests.
- Read-only Supabase device table aggregate showed **one paired device**, `agent_version=0.11.6`, with a recent `last_seen_at` on **2026-10-24** and a heartbeat within 10 minutes of the query. This confirms only the Windows Agent → Supabase heartbeat path at that instant, not ChatGPT → Sites → Gateway → Agent authenticated command round trip. No PC command was sent or queued.
- Independent review found a misleading capability claim in the draft's `gateway_probe` response: the original gateway continued to report `safeWrite:true` / `orchestration:true` even when the Site client had only three read-only/bootstrap tools. Both authenticated GET metadata and MCP `gateway_probe` now use the same `clientCapabilities(clientPolicy)` helper. The Site client reports `readOnly:true`, `safeWrite:false`, `orchestration:false`, while explicitly privileged legacy clients retain their prior flags. Added a regression test.
- Until a separate production release and client ID verification, the updated draft source has no effect on the running Supabase gateway. Sites saved version 10, Cloudflare relay, OAuth flags, secrets, DB schema and PC action state have not been modified.

## 2026-10-24 offline Site-to-Agent bootstrap contract test

As a separate **non-network** readiness check, `agent/test/goal29-site-bootstrap.test.js` now combines:
1. The real `resolveClientPolicy` / `isToolAllowed` / `visibleTools` policy helpers in this PR.
2. The existing `runQueueOnce` and `createPingTool` from the genuine local Agent.
3. A fully in-memory command envelope / fake queue transport, and an in-memory operation journal.

Four assertions cover an approved Sites OAuth client returning `pong` from the Agent runner, rejection of screenshot/GUI/write/task tools **before enqueue**, denial of spoofed headers lacking a verified JWT `client_id`, and the three-name bootstrap `tools/list` contract.

**Evidence:** Agent CI (Windows) run [40099238639](https://github.com/EliteMay/pc-agent/actions/runs/40099238639) succeeded; Gateway CI run [40099242882](https://github.com/EliteMay/pc-agent/actions/runs/40099242882) succeeded. The run creates **no** Supabase command or external request. It is deliberately not counted as a genuine ChatGPT → Sites → authenticated Gateway → Windows PC end-to-end test.

**Read-only live inventory only:** the paired PC Agent's heartbeat to Supabase was fresh at the time of inspection; historical `kaito_pc_commands` aggregates showed 8 completed `ping` and 2 completed `notepad_gui` records in the previous 30 days (latest on 2026-10-08). These historical records are not attributable to a successful *current* ChatGPT Sites integration and should not close Issue #29.

Release gate unchanged: confirm exact OAuth client ownership and legacy compatibility, keep Sites/Relay OAuth OFF, do not deploy this draft or send a PC command without separate authorization.

## 2026-10-24 pre-rollout endpoint isolation check (read-only)

Using read-only queries with **no client IDs, URL values, secrets or JWTs returned**, we classified the three OAuth registrations more precisely:

- 2 **public** registrations from 2026-10-06: generic/non-PC registration names and **loopback** callback addresses. These have a combined 2 consent records. Their actual relation to retired Plugin releases remains unproven.
- 1 **confidential** registration from 2026-10-09: PC Agent-related registration name and the precise Site callback **hostname with an HTTPS URL boundary** (not merely a substring match). It has 0 consent records; this is still only a *candidate* for the masked Hosted Secret ID.
- No Cloudflare `workers.dev` callback registrations were present during the audit.

### Important global authorization invariant

The current production OAuth Gateway v15 checks the signed user's allowed UUID, **but does not distinguish OAuth client IDs**. A separate minimal Site-specific MCP endpoint **alone** would not enforce least privilege: a bearer token issued to that Site might also authenticate to the unchanged older full-capability Gateway endpoint, causing a cross-endpoint privilege bypass.

Accordingly, **all reachable Gateway endpoints accepting Site bearer tokens must enforce client-specific authorization** before any command is queued. PR #47 scopes the existing full Gateway rather than adding a parallel API. Merely hiding tools in the Site's UI or adding a new read-only endpoint without protecting the legacy one is not an acceptable workaround.

### Remaining real-world blockers, not solved by offline tests

1. Formal Site management masks the client ID Secret. Registration host/name classification is strong circumstantial attribution, **not proof of identical client IDs**. Do not log, reveal or guess the Site Secret.
2. Explicit legacy compatibility decision: the two generic loopback clients must **not** be bulk-listed as privileged. Without proof of necessity, the safe PR #47 default is zero privileged clients, but this would intentionally deny previously authorized legacy clients after deployment. Approval of that compatibility tradeoff is required.
3. The callback/log protection gate (PR #42) and separately approved OAuth enablement must be satisfied before any live token is issued. No redirect/Secret/DB/PC mutations were made in this analysis.
4. For the eventual protected real-world test, independently check Site client `tools/list`, a harmless `gateway_probe`, a no-side-effect denial of disallowed `tools/call`, then `relay_ping`; **only after authorization and an explicit PC-action approval** may the actual `ping` command be queued.
