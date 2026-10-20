# Issue #29: Sites保存版3の公開候補・D1 migration・署名鍵・復旧ゲート（未承認）

更新: 2026-10-20。対象: `EliteMay/pc-agent` Draft [PR #42](https://github.com/EliteMay/pc-agent/pull/42) / [Issue #29](https://github.com/EliteMay/pc-agent/issues/29)。

## 目的・Evidenceの境界

第1目標の通常ChatGPT→自作Plugin→自作Agentによる家PC操作へ進むため、既存本人限定 `Kaito PC Agent Web Bridge` を維持しながら、Sites保存版3 (`bbb15b2`) の将来の**ダミー限定** Hosted実行を安全に準備する。**この文書は設計・承認判断用であり、Sites/WorkerのDeploy・Secrets・DB・実OAuth・PC操作を許可しない。**

- **Workの本人提供readback:** 保存版3 `bbb15b2`、作業ツリーclean、内部mock統合テスト32/32 PASS、後日の再実行12/12 PASS。ブラウザQAプレビューは本人Session/Origin未確認で起動せず。実行入口へのmock注入はテストだけ。
- **Workの本人提供hosted readback:** 現行公開SitesでD1 Binding 0、テーブル0、Hosted SecretsはOAuth用の4件のみ。Relay署名Secretなし。D1作成単独の正式native操作は見つからず、デプロイ時にDB構築→migration→コード切替となる可能性がある。**実際のSites native tool仕様、実行順序、復旧操作は次のWorkセッションで再確認するまで確定事実とはしない。**
- **ChatGPT通常チャットの実probe:** 公開済みPlugin `gateway_probe({})` は `fixed-diagnostic` / `supabase_connected:false` / `pc_connected:false`。保存版3のHosted稼働証拠ではない。
- Workerは既存Cloudflare Freeの `kaito-oauth-callback-relay-dummy` を再利用。Cloudflareの現行版と旧版metadata/D1参照は過去にreadback済みだが、配置版とPR #42のbundleバイナリ同一性は未確証。既存Worker Secretの値はCloudflareから読み戻せない。最新コードの `src/sites-client.mjs` はserver-onlyで、実Work Siteへのadapter wiringは未実装。
- **禁止:** 本人許可のないSites/Cloudflareの配置・配信切替、Hosted DBへの変更、migration、Secret設定・ローテーション、Site公開範囲変更、実Workerへのダミー送信、Supabaseの実認可コード・tokenの処理、家PCへの操作。

## 1. 公開候補（現本番は変更しない）

Work上の新たな「公開候補」は既存の**保存版3を基にした未デプロイの改訂**として作る。Cloudflare・Supabase・PCとは独立。以下は候補が満たすべき**確認項目**であり、動作保証や「保存版4作成済み」を意味しない。

1. **固定診断の後方互換:** 既存のPlugin tool名 `gateway_probe` /引数/戻り値・本人限定アクセスを維持。Supabase/PC接続に成功したかのような状態・write権限・ブラウザUIを追加しない。
2. **ダミーRelay機能は初期状態OFF:** 新規Sites `/oauth/start` / `/connect/complete` は feature/config の条件を満たさなければ固定503等の有限エラーでfail-closed。既存OAuth endpointの実`authorize`/`token`呼び出し不可。Configが未登録の初回deployで既存診断を落とさないことをテストで確認。Feature gateを本番に追加する要否と既存コードとの最小差分はWorkが検証し、追加できなければ公開停止。
3. **SessionとCSRF:** owner/sessionの正本はSitesの信頼済みdispatch/HttpOnly cookie、Originは明示的な既存本番HTTPSの固定値。内部QA用`terminal.local`を本番Allowlistへ追加しない。test owner header等をproductionへ持ち込まない。
4. **実Worker接続アダプター（有効化前に実装・テスト）:** server-only `createSitesRelayClient` の `fetcher` にWeb標準fetchを使い、固定 `https://kaito-oauth-callback-relay-dummy.k12m45k.workers.dev` のみ許す。署名用keyはSites公式Hosted Secretからのみ読み、ログ、client bundle、MCP response、query、cookieに出さない。POSTは`/prepare`/`claim`限定、redirect reject、timeout上限・response size上限・unknown JSON field拒否を維持する。**キー・DB準備前にLive送信しない。**
5. **Save/Bundling:** 本人限定共有と現在の公開 `gateway_probe` を維持。保存版3 `bbb15b2` はSite Work側の保存コミットであり、PRのGitHub SHAと混同しない。候補のWork commit、bundle digest、migration ID、既存公開Version/deployment IDを記録してから判断。
6. **最低限のテスト:** 旧20＋新12だけでなく、`DB` bindingなし・schema未適用・Relay secretなしでも固定診断の既存応答を維持するテスト、OAuth禁止・Relay機能OFF・失敗応答の匿名化、owner/CSRF/replay/timeout、Browser bundle Secret marker 0、`node --test`/type/lint/buildを確認する。既存のテスト件数やPASSを実クラウド成功と誤認しない。

## 2. Hosted D1作成とmigrationの安全ゲート

**重要:** Work readbackではD1単独作成コマンドが見つからず、Sites managed deployに連動してDB作成/Schema migrationが**コード公開前に先行し得る**。初回デプロイを「DBだけ構築」目的で実行しない。

WorkがSites nativeから次を実際に読み取り、表に埋めるまで外部WriteはSTOP:

| 必要な確証 | 現時点 | STOP条件 |
| --- | --- | --- |
| 既存の公開Site deploy ID / known-good source、共有範囲 | 再取得待ち | 旧版へ復旧する公式操作が不明 |
| 保存版3が使う実D1 schema / migration SQLと順序 | 保存版コード自体は通常チャットから読めず未確認 | 暗黙の破壊的SQLや未確認のデータ移行 |
| 既存Hosted DBとnew DBの識別・テーブル実在、migration log | 現行Binding 0・table 0（Work報告） | DB対象が不明・別SiteのDBを触る危険 |
| old code + new schema で `gateway_probe`継続 | 未検証 | 旧版がmigration後に壊れる |
| new code + migration未適用 / Secret未登録のfail-closed | 未検証 | 未設定時にfixed probeも失敗する |
| Sites deploy失敗後のDB残存と公式復旧方法 | 未検証 | DBが変更されうるのに止め方がない |
| Free枠・D1作成課金条件 | 既存実行0円優先、現時点の利用条件未確認 | 自動課金やPaid移行の可能性 |

実行前のmigration候補は**既存テーブル非破壊の追加だけ**を原則とし、`DROP`、既存行の`DELETE`、旧列置換、既存Auth/session/pendingの意味変更を含めない。テーブルが0件とのreadbackは「本番保存データが絶対にない」の証明にならない。Migration replay/idempotency、部分成功・再試行の挙動、既存の暗号化pending・sessionのread互換をテストする。DB新設しか行わない候補でも、DB名/ID・テーブル構造・migration recordが実際に正しいかを確認する。

**復旧方針:** デプロイに失敗しても旧公開Siteが応答する場合、旧版維持を第一とする。DB migrationが先行済みなら**自動Down migrationを行わない**。互換性が確認できた旧コードを維持して原因を調査し、安全なforward-fixとDB個別復旧を判断する。コードを戻すこととDBを戻すことを同一操作扱いしない。破壊的DB復旧は別承認。

## 3. 署名鍵の安全な配布（未実施・要判断）

- 使用中のCloudflare Workerには `RELAY_SIGNING_KEY` Secretが存在するが値のreadback不可。Sitesには既存OAuth用4件しかなくRelay用Secretは**無い**。Cloudflare側の暗号化鍵`RELAY_STORAGE_KEY`はSitesへ**共有しない**。OAuth client secretもWorkerへ送らない。
- **第一候補:** 本人だけが管理する既存の安全な保管先に現在の`RELAY_SIGNING_KEY`の元値が現存し、本人が値の出所と整合を確認できる場合、Sites公式のHosted Secrets UIへ同一値を直接投入する方式を検討する。ChatGPT / Workチャット / GitHub / Cloudflareダッシュボード読取経路へSecret文字列を出さない。**保管先不明なら「取得できる」と推測しない。**
- **第二候補:** 元の署名鍵を本人が再取得できなければ、本人が承認した管理下で**新たな鍵を生成し、SitesとWorkerを計画的に更新する**。更新の前後で既存dummy pending（TTL 5分）とnonce（90秒）の滞留・署名失敗・rate/cron影響を確認。更新順序、ダウンタイム・切替手順・Worker active Version変更、旧鍵の再利用不可、復旧不可リスクを事前に明記する。Secret上書きがWorker新Versionを作り得るので、その発行・100%配信も別途明示承認が必要。鍵ローテーションを本会話で実行しない。
- Site側Secret登録には**Sites独自の公式Hosted Secret書込手段**が必要。登録可能でも、実行時のkey読み込み・Server-only境界・ログ出力なし・追加料金なしを実環境で確認するまでsigned Live送信不可。新しいサービス、API Key、共有ログ置き場を増やさない。

## 4. 別途承認後の公開・復旧実行手順（この文書では一切実行しない）

| Gate | 入力・実施 | 成功条件 | 失敗時 |
| --- | --- | --- | --- |
| A: 書込み前 readback | 現行published Site ID/commit・共有者数・DB Binding/Schema/Secret名、GitHub PR/Work candidate固定、Sites正式rollout/restore仕様の取得 | 現本番へ復帰する実操作を特定でき、Additive migrationで旧Probeが維持 | 不明ならDeploy停止 |
| B: Release candidate QA | OAuth/Relay実通信は無効。正常/拒否/未設定時/old-code+new-schema互換をmock・ローカルSQLiteで検査。client bundle監査 | テスト・type/lint/build PASS、既存 `gateway_probe`契約維持、Public JSにSecretなし | 修正して**未公開保存**、再検査 |
| C: 個別本人承認 | Hosted D1作成/migration・Sites deploy・Secret登録・Worker署名key更新・Workerへ実リクエスト、の操作ごとに効果とリスクを説明 | 本人が**どの操作に同意したか**明確 | 承認がない操作は実施しない |
| D: Sites管理Deploy（承認済みの場合のみ） | nativeによりどのmigrationがいつ適用されたか、deploy ID、DB ID/schema versionを記録。初回はfeature OFF・固定診断維持 | 固定Plugin本人認証で公開の `gateway_probe` は旧どおり `fixed-diagnostic`; 新Relay routeは未設定時fail-closed | 旧版が正常なら維持。DBは自動巻戻し禁止。原因を特定しforward-fix/別復旧 |
| E: Dummy-only Live（別承認後） | key/binding/Origin/本人認証を検証し、固定test state/codeを使いSites server→Worker`/prepare`→dummy callback→`/claim` | 201→303→200→replay拒否（状態消費はWorker 409等、Siteはlocal pending無しで拒否でもよい）。実D1暗号文消去/TTL、Secret/URL不露出 | 失敗ステータス・投入環境・DB書込結果を記録、再試行乱発や鍵/権限緩和はしない |
| F: 第1目標へ復帰 | 上記とは別にOAuthログ保護・本人同意・既存Supabase Gatewayへ認証済みprobe。さらにPC Agent/Managerと安全承認を実機で検証 | Issue #29の4条件を**Remote Desktop Commander停止中**に実証 | dummyテストをPC接続の成功扱いしない |

復旧時の判断:
- `Site deploy失敗`＋`旧固定Plugin正常` → 本番Siteは変更せず、migration残存を監査して停止。
- `Site新コードが旧Pluginを壊す` → **以前の公開known-goodを正式機能で復元可能・新schema後も安全**であることを確かめてからコード復元（勝手に実施しない）。
- `DB migration partially applied` → 追加SQL以外に何が実行されたかreadbackし、削除/restoreの自動実行禁止。既存保存データを失わないforward-fixを優先。
- `Relayの署名失敗` → 秘密値をログに出さず、key登録状態・active worker version・now/nonce/Originを安全なBooleanで判定。鍵の上書きや同じnonceを連打しない。
- `Cloudflare側Workerが不安定` → SitesのRelay動線だけOFF。Cloudflareの旧Versionの無条件rollbackは禁止（Script ETag相違・Secret変更履歴あり）。既存Site `gateway_probe`を維持。

## 5. 次のWorkへの作業指示（**READ/未公開コード候補の保存まで**）

1. 対象Siteで最新の保存版3（`bbb15b2`であるか再確認）、現在公開中の固定診断版のSource/Deploy ID・owner限定共有、Hosted DB/Secret名、実際に使うSites native Deploy/Migration/Restore仕様を**読み取り専用で確認**。
2. Site既存コードの**正確な**migration SQL、DB binding宣言、feature flag実装の有無、OAuth旧Routerと `gateway_probe` をレビューし、上記Gate A/Bの互換性を実テストできる最小案を提案。無理にfake preview / owner header等を追加しない。
3. 公開候補の内部コード変更が必要なら**未公開保存まで**で止める。CI・mock tests・type/lint/buildを確認。実際に動かした環境（SQLite in-memory vs Hosted D1、mock vs real Worker）を明記。
4. この文書の空欄（正確なSource SHA/Deploy ID、DB schema/migrations、戻し方、費用・Owner Secretの安全運用）をWorkの観測結果で埋め、**承認が必要な操作を短いチェックリストにする**。条件を満たさなければ設定・Secrets・Deploy・本番通信へ進まない。

**Stop condition:** 本番の固定Plugin維持とmigration失敗時の回復方法が独立して確認できないなら、Sites初回Deployを実施しない。技術的に停止中でも正常な判断である。

参考: [Cloudflare Relay Runbook](issue-29-cloudflare-deploy-runbook.md)、[Sites handoff](issue-29-chrome-plugin.md)、[Guide Security](https://github.com/EliteMay/web-project-guide/blob/main/docs/06-security.md)、[Guide Testing](https://github.com/EliteMay/web-project-guide/blob/main/docs/07-testing-quality.md)、[Guide Data](https://github.com/EliteMay/web-project-guide/blob/main/docs/03-data-storage.md)、[Guide Maintenance](https://github.com/EliteMay/web-project-guide/blob/main/docs/09-maintenance.md)。
