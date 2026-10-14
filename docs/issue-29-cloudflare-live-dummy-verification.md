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
