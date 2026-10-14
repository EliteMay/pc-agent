# Issue #29 — Cloudflare 実環境ダミー検証記録

2026-10-14 (UTC) / 2026-10-15 JST。PR #42 branch `feat/issue-29-cloudflare-relay-dummy` のdummy-onlyコードを、本人管理のCloudflare Freeアカウントの検証専用Worker/D1へ配置して確認した記録。実OAuth・Sites本番・Supabase・家PCは未変更。秘密値・アカウントID・メールは記載しない。

## 配置した実体

- Worker `kaito-oauth-callback-relay-dummy`（既存Hello Worldを上書き。他Workerなし）、origin `https://kaito-oauth-callback-relay-dummy.<account-subdomain>.workers.dev`。
- D1 `kaito-oauth-callback-relay-dummy`を新規作成（事前に`d1 list`が空であることを確認）。`migrations/0001_relay.sql`をremote適用（6 commands）。
- `RELAY_SIGNING_KEY`/`RELAY_STORAGE_KEY`: 本PCで生成した互いに異なる32-byte鍵を標準入力から`wrangler secret put`へ直接投入。チャット・Git・ログへは出していない。署名鍵のみ検証用に一時保管（検証後に削除対象）、暗号化鍵は保存せず破棄。**dummy専用で、実OAuth用には再生成する。**
- 実D1 idを入れた設定は未コミットの`wrangler.local.json`に分離（`wrangler.json`はplaceholderのまま、`npm run check`が要求）。
- 認証は`wrangler login`のOAuth。Freeプランであることを示すAPI値は未取得（作成できたことのみ確認）。

## 実効ログ設定（重要な発見）

- Script Settings GETの`observability`は、`wrangler.json`のdeploy後もJSON PATCH後も **`null`**。`logpush:false`、`tail_consumers`はnull（/settingsでは`[]`）。
- 検証: `enabled:true`にするとAPIは`persist:true`/`invocation_logs:true`/`redact_query_string:false`の既定を返し、`enabled:false`へ戻すと再び`null`。disabledでは`redact_query_string:true`を送っても**保存されず観測できない**。
- したがって`inspectLogSettings`の`matched`条件（redact=true等の明示値）は、observability無効のliveでは**原理的に満たせない**。現状`unverified`が正しい出力で、「ログ非保持」の合格根拠にはならない。観測できる事実は「observabilityは無効（null）」のみ。`redact_query_string`の実効値、Cloudflare内部/edgeのログ層は未検証。
- 対応（本人判断済み）: `inspectLogSettings`を3状態化。`matched`（明示値が全一致）/`disabled_observed`（`observability:null`かつ`logpush:false`かつtail無し=無効を観測）/`unverified`。`disabled_observed`でも`redaction:"unverified"`、`platform_log_scope:"unverified"`、`live_oauth_allowed:false`は固定。observability項目の欠落（null以外）は`unverified`のまま。liveのdummy Workerは`disabled_observed`と判定される。テスト37件成功。
- 補足: `wrangler deploy`のconfigにobservabilityを書いても反映されなかった。JSON bodyのPATCH（multipartは400）で明示設定した。

## ダミー機能のlive結果（workers.dev, 署名付きリクエスト）

| 項目 | 結果 |
| --- | --- |
| prepare | 201、約260ms |
| 同一nonce再送 | 409 |
| callback | 303、Locationは固定URL（query無し）、`cache-control: no-store`、body 0 |
| callback再送 | 409 |
| 誤binding claim | 409（消費されない） |
| 同時claim 12本 | **200が1本のみ**、残り11本が409。勝者のbodyは`code/outcome/state`のみで値一致 |
| 消費後claim | 409 |
| 署名なし / 別鍵 | どちらも401 |
| callback前claim→callback→claim | 409→303→200（登録は維持） |
| 期限切れ（TTL300s超） | claimは409 `state_unavailable` |
| D1内容 | consumed行は暗号文消去、ready行にplaintext `dummy-code`なし |

## 未解決/注意

- **cron cleanup**: 期限切れ行（nonce 20、pending 3）が、期限後10分以上`* * * * *`のcronで削除されず残った。`wrangler dev --remote --test-scheduled`の`/__scheduled`手動実行では全削除でき（コードとD1は正常）、後日投入した期限切れcanary行は数分後に削除された。cronの実行遅延/間隔は未解明で、「毎分削除」とは断言できない。claim側は期限切れを拒否するため機能上は安全だが、`ready`行の暗号文が期限後もしばらく残る点は保持期間の説明に反映が必要。
- CPU: 直近の分析（28 requests、errors 0）でp50 約1.8ms、p99 約7.9ms（Free上限10msに近い。sample少）。D1使用量（rows read/written）の集計、10ms超過の負荷試験、無料枠の実測は未実施。
- 固定窓rate limit（prepare5/10分、claim20/分）は文書化済みのまま。
- Sites POST bodyログ、Cloudflare非公開ログ、D1 backupは未検証。本番OAuth/Sites統合は引き続き禁止。

---

# 追加検証と判定（2026-10-15 JST、HEAD 11294fa 以降）

web-project-guide v1.22.0（`docs/06-security.md` OAuth節: URL/ログへのToken非露出、callbackの任意転送禁止）に照らして確認。コード変更なし、記録のみ。

## 問題の3分類

### A: 修正しないと次へ進めない問題 — **なし（dummy relay範囲）**
- 再現した機能不具合・安全不具合はなし（live 5往復 201/303/200、同時claim 1/12、replay・誤binding・期限切れ・署名不正すべて拒否）。
- ただし**live OAuth統合時の必須作業**として別枠（下記「統合時に必要な変更」）。

### B: リスクを明示して本人が許容判断する問題
| 項目 | 事実 | 残るリスク / 対策 |
| --- | --- | --- |
| 認可コードがCloudflare edge/callback URLを通る | observabilityは無効（API `null`）。`redact_query_string`は無効状態では保存・観測不可。Worker側コードはqueryを保存・出力せず303固定先にqueryを付けない | Cloudflare内部/edgeログ層、ブラウザ履歴にcode付きURLが残り得る。**緩和**: コードは単回・TTL300秒、PKCEのverifierはSites側のみ、Supabase OAuth Appはconfidential（client_secret必須。本人報告。統合時にSupabase設定で再確認）→ code単独では交換不能。 |
| cron削除遅延 | 当初、期限後10分超で残存（原因不明、schedule新規作成直後の伝播遅延の可能性、未証明）。再計測3回は seed→削除 37/56/56秒（観測間隔・wrangler遅延含む）、`/__scheduled`手動実行でも全削除 | 遅延中も期限切れclaim/callbackは拒否される。ciphertextのみがD1に残る（暗号鍵はWorker Secretのみ）。再デプロイ・Secret更新直後は数分遅れ得る前提で保持期間を「TTL+数分」と扱う。コード変更はしない（原因未特定のため）。 |
| 無認証/不正リクエスト | 署名なしは401、未知stateのcallbackは409。署名前にD1書込みなし | 無料枠(100k req/day)を攻撃で消費する可用性低下は防げない（rate limitは認証後）。本人用途では許容。 |
| 固定窓rate limit | prepare5/10分、claim20/分、境界で瞬間倍 | 前記載のまま。 |

### C: プラットフォーム制約で検証できない問題
- Cloudflare非公開/内部ログ・CDN・Logpush外のログ保持、D1 backup保持期間。
- `redact_query_string`の実効値（observability無効だとAPIがnullを返し観測不能）。有効化して観測するとログ永続の既定(persist/invocation_logs=true)が付くため**実施せず**。
- Sites側のPOST response bodyログ（本人限定Siteの正式接続が必要）。
- Freeプランの機械確認: 本トークンは`/subscriptions`が403。作成できたこと以外は**ダッシュボードでの本人確認が必要**。
- 「ログ完全非保持」は保証できない。確認できた事実は上記のみ。

## 測定結果（dummy Worker、実環境）

- Workers CPU（110 invocations、errors 0、フル往復5回+軽量リクエスト+cron含む）: p50 1.0ms / p90 2.4ms / p99 4.9ms / p99.9 6.3ms。Free上限10ms未満（先の28件p99 7.9msは標本少・コールド起因と推定）。重い経路(prepare/callback/claim)の個別分離は未実施。
- D1（同時間帯）: read queries 65 / write queries 46 / rows read 94 / rows written 84 → Free上限（5M read rows/day、100k write rows/day）に対し桁違いに小さい。cron毎分のDELETEは対象行が無ければ書込みなし。
- Workers requests: cron 1440回/日を含めても100k/日に対し小。

## 設計レビュー結論

重大な設計欠陥は見つからなかった: 署名(HMAC)+nonce永続replay防止+owner/browser binding+AES-GCM(AAD束縛)+原子的単回claim+固定303。Workerは`client_secret`/`service_role`/家PC鍵を持たない。

## 統合時に必要な変更（今回未実施）

1. `dummyCode`正規表現（`dummy-code-…`のみ許可）とclaim検証を、Supabase実コード形式の厳格な検証へ置換（形式は公式仕様で確認してから）。
2. callbackが`access_denied`以外のerror（`server_error`等）を400にする挙動の扱いを決める。
3. dummy検証用に生成した署名/暗号鍵は破棄し、本人PCで新規生成して公式UIへ投入（Sites側にも署名鍵）。
4. `RELAY_MODE`/mode分岐、`RELAY_ORIGIN`をlive用に更新、再デプロイ後にcron削除を再計測。
5. 統合後もSupabase redirect URIの追加（本人操作）、新旧callback、token交換のredirect_uri一致を維持。

## 判定: **条件付きGO**（Sites OAuth統合の「設計・実装準備」へ進む）

条件:
1. 本人がB/Cの残留リスク（Cloudflare内部ログ・ブラウザ履歴・Sites POST bodyログの非保証）を、PKCE+confidential client+単回TTL300秒の緩和込みで許容する。
2. Supabase OAuth Appがconfidentialでclient_secretが必須であることを統合前に本人が設定画面で確認する。
3. Freeプランをダッシュボードで本人確認する。
4. 実OAuth同意・Supabase redirect追加・Sites本番再公開は、統合実装とdummy→liveの再テスト後に個別承認。

NO-GOとする条件: 許容できない場合、またはconfidential client/PKCEが成立しない場合。この場合は本番認可コードを発行しない。
