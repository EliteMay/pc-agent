# Cloudflare callback relay dummy validation implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement these tasks in this session. The user explicitly requested implementation and tests with only necessary owner-operation stops; no additional design approval is needed for this approved spec.

**Goal:** 正本のcallback relayを、実OAuthを受け付けない検証版として実装し、自動テストで通信・保管・拒否条件を確認する。

**Architecture:** 本人管理Workerがcallbackを受け、Sitesへqueryなしの固定303を返す。Sitesのサーバーが署名付きPOSTで事前登録・一回claimする。D1にstate/bindingのハッシュとAES-GCM暗号文を保管し、単一トランザクションでclaim後の暗号文を消去する。

**Tech Stack:** Workers standard Web APIs, D1/SQLite, Node.js 24 built-in test runner and SQLite; production dependencies zero.

**Spec:** `docs/issue-29-cloudflare-callback-relay.md` (canonical blob edb0e9111a7a86d1b7b2e81ca0bcf9205cfd1cc4, unchanged).

## Global Constraints

- 実際のOAuth同意、既存Supabase OAuth App変更、Sites本番再デプロイ、家PC操作は行わない。
- 既存保存版2、Hosted Secrets4項目、本人認証、S256 PKCE、Windowsローカル承認を変更しない。
- Workerは`dummy-code-`形式だけを受け付け、live modeを実装しない。
- コード・stateはSitesのURL、ブラウザ応答、cookie、console、MCP、例外、GitHubへ出さない。テストの無害な固定値だけはfixtureとして使う。
- 無料Planのまま超過時停止。Cloudflare account/resource/secret設定と実効ログ設定は未検証として残す。
- 新しいfeature branchのみへ保存し、main merge・Worker deploy・Sites版保存は行わない。

## Review Focus

- 偽callbackと保存容量攻撃: 未登録stateは保存せず、signed prepareを5回/10分・active5件へ制限。
- 同時claim/nonce replay: 永続nonce一意制約と原子的claim/暗号文消去をSQLiteで並行検証。
- origin/redirect/identity: HTTPS固定origin、queryなし固定return URL、owner/browser binding、外部redirect拒否。
- 期限/保存失敗: TTL300秒で即時拒否、毎分cleanup、例外を有限の安全な応答へ変換。
- 本番保護の誤認: 設定ファイル・実効API値・ダミーログ観測・非公開ログを区別し、未確認をsuccessへ丸めない。

### Task 1: Worker / authenticated storage

**Files:** `gateway/cloudflare-callback-relay/src/{worker,protocol,store}.mjs`, `migrations/0001_relay.sql`, `tests/{worker.test,helpers}.mjs`.

**Interfaces:** `createWorker({clock}) -> {fetch(request,env), scheduled(event,env)}`; signed POST `/prepare` and `/claim` JSON `{state,binding}`; GET `/oauth/callback`; `state` is 43-character base64url, `binding` is a SHA-256 digest; TTL300s, signature skew30s.

- [x] Write tests for fixed query-free 303, no cleartext in storage, invalid signature/state/issuer/code rejection, expiry, concurrent claim, replay, rate limits, corruption and DB rollback.
- [x] Run tests RED against fail-closed stub; expected success path asserts 201 vs503.
- [x] Implement HMAC-SHA256 over audience/method/path/time/nonce/body digest, AES-GCM with bound metadata, D1 transactions and static safe errors.
- [x] Run all Worker tests GREEN and syntax checks; no outbound Worker fetch exists.

### Task 2: Sites server pull / local OAuth fixture

**Files:** `gateway/cloudflare-callback-relay/src/sites-client.mjs`, `tests/sites-client.test.mjs`.

**Interfaces:** `createSitesRelayClient({origin,key,authorize,loadPending,consumePending,invalidatePending,exchangeDummy,fetcher,clock}) -> {prepare(request,pending), complete(request)}`. Only trusted Sites server owner/session hooks may supply pending data; browser response is a finite status without code/state/verifier/token.

- [x] Write tests RED for owner/browser denial before transport, body-only claim, state mismatch, atomic local pending consumption, duplicate completion, exact relay redirectUri + verifier in dummy exchange, denied consent, failed exchange/redirect/timeout/excessive response.
- [x] Implement server-only client with pinned HTTPS origin, credentials omitted, redirect error, request/response bounds and no automatic retry after consumption.
- [x] Run complete module suite GREEN and original unchanged Sites20 tests.

### Task 3: Logging / cost evidence / handoff

**Files:** `wrangler.json`, `src/log-policy.mjs`, `tools/check.mjs`, `tests/log-policy.test.mjs`, `README.md`, `docs/issue-29-cloudflare-relay-verification.md`, `.github/workflows/callback-relay-ci.yml`.

- [x] Test effective settings validator RED: redaction=true, enabled/logs/invocation/persist/traces/exports=false/empty, logpush=false, tail_consumers=[]; absent or enabled fields fail.
- [x] Implement sanitized validator and no-deploy CI; record Workers/D1 Free limits and upstream-log/backup limitations.
- [x] Run full new suite, syntax/secret checks and whole-branch security review; fix substantive findings with failing-then-passing tests.
- [ ] Push exact verified files with native GitHub API, create draft PR, verify remote content and CI, and append outcomes/owner-only next operations to Issue29.

## Rulings / execution ledger

- User supplied and authorized the canonical design and implementation/test scope; repeated spec/plan approval would conflict with the explicit minimal-stop instruction.
- D1 chosen over DO: sufficient Free quotas, same prepared-SQL pattern as saved2, local SQLite can exercise exact transaction SQL. Cloudflare runtime and 10ms CPU quota remain live validation gates.
- Signed `/prepare` is a narrow security addition needed to reject unsolicited storage, not a new OAuth or PC capability.
- Saved2 only keeps state digest; later integration must include raw state inside its existing encrypted pending envelope and load it by owner/browser. This turn does not modify saved2.
- Node/SQLite tests do not prove deployed Workers behavior or platform-log non-retention. The implementation stays dummy-only.

## Verification ledger

- Task 1: complete. Worker RED: 17 failed/2 passed against fail-closed stub; initial GREEN:19/19. Rollback boundary added and whole suite36/36 PASS.
- Task 2: complete. Sites RED:7 failed/5 passed against stub; initial combined GREEN:31/31. Original unchanged saved2 tests20/20 PASS, HEAD63f617624ef192bc397e0b875eda5593bc3ac854, clean.
- Task 3: logging validator RED:1 failed/3 passed, then full GREEN36/36. Syntax/static checks11 modules PASS. Native GitHub publication and CI confirmation pending.
- Final review: fresh independent reviewer found no dummy-only blocker; tests36/36 and check11 modules independently PASS. D1 runtime, platform logging, CPU/quota and production Sites integration explicitly unverified.
- Final: minor (deferred): fixed-window limits allow boundary bursts; semantics documented; rolling-window policy to be decided before live integration. Cost if left unresolved: prepare10/claim40 can occur across a boundary, so rates cannot be described as rolling ceilings.
- Ruling: isolated source projection + native Git data API used instead of a full local git worktree — network supports the GitHub connector and exact base-tree CAS — cost if wrong: full-repository CI may find integration problems; no main merge/deploy occurs.
- Ruling: per-task intermediate commits consolidated into one verified feature commit — preserves canonical base tree and keeps untested partial sources off the remote feature branch — cost if wrong: coarser bisect granularity.
- Durable coordination guard verified on data coordination/ws-20261010-issue29relay before publishing implementation; current canonical Data main and feature base lease must still match before mutation.
