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


7. **CSRF追加レビュー: state-changing GET:** GitHubの現行 `gateway/cloudflare-callback-relay/src/sites-client.mjs` は `GET /connect/complete` で`consumePending`→署名付き`/claim`を呼び得る。通常のSite saved-v3コードにさらに保護があるかは未確認だが、認証付きブラウザが他Originから強制遷移されるとpendingを破棄させられる可能性がある。**同じOriginのGETを表示/検証だけにし、本人セッション由来のCSRFを伴う同一Origin POSTでconsume/claimする案**をWorkで既存Routeと照合。安全なPOST動線・Cookie検証・query-free callback 303を両立できるまで実OAuthを有効にしない。モックテストの通過だけで、実ブラウザのCSRF安全性は証明できない。

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

## 2026-10-20 保存版4の実装結果と「migrationを再実行しない」決定ゲート

**Workからの本人提供結果（この通常チャットでSiteコード/実行ログを独立取得していない）**

- Sites未公開の保存版4 commit: `7b773ddbaf36d5ef1248a980b7ca4dd37c67a521`。公開中の既存固定診断Pluginは変更なし。
- `gateway_probe`既存Contract維持。D1/Secret/schema未設定時もfixed probeはmock検証で正常。Relayと実OAuthは初期OFF、単なるenv-var入力では有効にならない構成。
- `GET /connect/complete`は状態変更しない。本人/HttpOnly Cookie/Origin/CSRFを満たすPOSTのみpending consume/claimを行う。Workの報告では37/37テスト、型、lint、build成功、client artifactの指定Secret marker 0。
- **重要:** 4個の新規テーブルだけをCREATEする現行migrationはローカルSQLiteで旧版互換・既存データ維持を確認したが、**同じSQLの再適用や途中適用後の単純再実行では失敗**。Hosted migration履歴、partial applyの挙動、rollback後のschema互換はまだ未検証。Hosted D1 Binding 0、table 0（Workからの過去読み取り）。
- Workの報告は**安全な初回Hosted migration成功**を証明しない。未公開保存だけなので本番データを変更していない。

**本番前の次の1課題: Sites native migration runnerの厳密な実装確認**
1. Sites Workで、現在の保存版4 `7b773ddb…`、公開中Version ID、migration SQL全文、schema/catalog宣言、正式デプロイ操作のmigration実行順序、migration履歴テーブルとTransaction境界を**実際に読み取る**。どのチェックポイントから自動再試行するのか、途中で4テーブル中1〜3テーブルだけ存在するとどうなるかを明確にする。推測しない。
2. 一度だけmigrationが実行されることを履歴で保証する設計でも、**デプロイ途中失敗時のSQL再実行**と差分整合の検証が必要。空のローカルDBだけでなく、A.未適用、B.全部適用済み、C.1〜3テーブル適用済み、D.同名テーブルが異なるschema、E.旧code+new schema、F.新code+schema未適用をテストする。
3. **部分適用後の反復実行に失敗するなら**、既存テーブル破壊を伴わない最小限のmigration/runner修正案をWorkで準備し、検証後も未公開保存にとどめる。`CREATE TABLE IF NOT EXISTS`は**不一致schemaを無視する**危険があるため、安易に付けるだけでは合格としない。正しいschema fingerprint/列・index検証、明示的migration version/history、既存データ非破壊とTransaction境界に合わせる。
4. 公式Sites操作でmigrationの独立Dry-runが利用できない場合はその制約を記録し、初回Deploy前に旧固定Pluginの復旧手順（source/deploy ID、DB残存確認、environment/Secret変更影響）を実観測できる状態にする。**実Deploy/新D1/Hosted migrationの実行は別途本人承認**。

**追加の現在仕様:** [OpenAI公式Sites Help](https://help.openai.com/en/articles/20001339-creating-and-using-chatgpt-sites)は「publishing can change the Site's database before the new version goes live」「restoring earlier version restores code, not DB/files」「regional hosting siteのSecret値更新は再公開なしでもliveに影響し得る」と明記。Sites利用料は[同ヘルプ](https://help.openai.com/en/articles/20001339-creating-and-using-chatgpt-sites)で「building/editing counts toward Codex usage、run/hostingは別枠」と説明されるため、**Cloudflare Workers FreeだけでSitesの追加費用0円を保証しない**。現在の本人環境で課金/QuotaのUIを確認するまで本番Deployを承認しない。

**次実装の優先順位:** migrationの再試行/部分適用を調査→必要なら未公開修正→Hostの正規Deployと課金・復旧ゲート確立→必要最小限のサーバー限定通信adapterと本人POST UI→署名鍵の安全なSecret登録案→本人承認後にdummy実通信。未実施のOAuthや家PC E2Eを成功扱いしない。

## 2026-10-20 保存版5とSites正式migration仕様の確認ゲート

### Workが報告した未公開成果（正常性はWork報告、通常チャットからSites内部コードは未取得）

- Sites保存コミット: `4478d3490506340634a58a5b1403c02c97e5a41b`、未公開。固定診断`gateway_probe`の後方互換を維持し、Relay/実OAuthは初期状態で禁止。
- SQLite専用の非破壊リカバリとschema不一致検出を追加。新規4テーブルが存在/欠落する全16状態、SQL再実行、旧データ維持、失敗時ロールバックを**ローカルメモリ内SQLite**で検証。
- 固定Worker Originしか使わないserver-onlyの実通信adapterと、本人/Cookie/Origin/CSRFを維持するPOST操作UIを実装。ただし**実Workerは呼び出していない**。
- Work報告では**46/46 tests PASS、型検査・lint・build PASS、実通信禁止テスト成功**。Hosted D1でこれらを実行したわけではない。
- **残る唯一のリリース前主要ゲート:** Sites Hosted D1の「migration履歴管理・Transaction境界・partial failure後のretry/resume」を現在の本人Siteのnative hosting toolingで検証できていない。ローカル復旧モジュールをHostedの自動Migration保証と解釈しない。

### 2026-10-20 OpenAI公式資料で新たに確認したこと

1. [Creating and using ChatGPT Sites](https://help.openai.com/en/articles/20001339-creating-and-using-chatgpt-sites) は、**デプロイ中にlive切替より前のDB変更が残り得る**こと、バージョン復元ではコードだけ戻りDB/ファイルは戻らないことを明記している。Sitesの正式migration runnerが全SQLを単一Transactionにすることや、自動retryが何を基準にするかは同ページから確認できない。
2. 同ヘルプの現行FAQは、**Plus/ProのSites hostingは現在利用プランに含まれる**と明記。Siteの作成・編集はCodex使用量を消費し、Sitesのrun/storageには共有限度がある。料金0円の目標に対し、**別サービスへの支出は不要と見込めるが、限度超過や製品の料金変更を勝手に許可しない**。Cloudflare Freeとは別のquota。旧文書にある「Plus/Pro Hostingが必ず別料金」という趣旨の解釈は採用しない。
3. [Sites developer guide](https://learn.chatgpt.com/docs/sites) と [Publish and share](https://learn.chatgpt.com/docs/sites/publishing-and-sharing) では、version saveとproduction deployが別ステップ、`.openai/hosting.json`内の`d1: "DB"`、artifact内のmigrationのReviewが必要なことを確認。公開資料の対象箇所から、**本人のSites backendでのmigration atomicity/idempotency/履歴表の仕様までは確定できなかった**。一般的なCloudflare D1/Drizzle動作からSites内部を類推しない。

### 次の1タスク（新しい保存版を作る前に、Sitesネイティブ読取と仕様照会に集中）

**対象:** 現在公開中の固定診断Siteと保存版5 `4478d349…`。他Site/Cloudflare Workerには変更しない。

1. Workで**現在のSites実装・専用skill/referenceの現物**を読み、利用可能なmigration/D1/hosting nativeコマンドの仕様、正式migrationパッケージ `dist/.openai/drizzle/**`、適用済みmigrationの履歴/チェックサム、Transaction境界、並行deploy/途中失敗時の規則を確認。API・tool説明とSource/Host観測を証拠として区別。専用機能が存在しなければ「未提供」と記録する。
2. ソース側の4テーブルmigrationについて、未適用/全部適用/部分適用の各状態を既存の**ローカル**検証結果と照合し、「Sites hosting runnerが自動で再実行しないことをどう保証するか」「1〜3テーブル適用後のcheckpointがどこか」を具体的に回答する。**正式Toolが答えられない場合、推測でYesにしない。**
3. Hosting nativeのread-only操作がある場合だけ、**現published deploy IDと共有範囲、既存DB Binding・tables/migration historyの有無**を再観測する。Viewerの変更/DB provision/URL作成/Secret登録/Worker接続・deployはまだ禁止。
4. MigrationのTransaction/復旧仕様が不明なら、OpenAI公式Supportへ問い合わせるための**非機密質問文**を準備する。Secret、Site owner email、private source/SQL本文、認証データをサポートへの初回依頼に記載しない。規約やhelpで保証されない処理を自作修正だけで解決済みにしない。
5. 質問へ回答が来るまでは、**Site公開・D1構築・migration適用を止める**。新しい保存版6や追加のローカルテストは、実際の失敗原因が判明してから必要な最小修正に限定する。無関係のCloudflare auditやプレビューの試行を繰り返さない。

### 公開許可ゲート（すべて未承認）

| 関連操作 | 条件 |
| --- | --- |
| Sites保存版5をproduction deploy（D1 migrationを伴う可能性） | 正式なmigration/復旧条件の把握、旧公開Site固定診断の復元経路、owner限定共有、課金/usage限度、対応バージョンを本人がレビューし**明示承認** |
| Sites Relay Secretの登録 | 既存Worker署名鍵の安全な同一値持込み方法が明確か、別承認の鍵ローテーション計画。値はGitHub/会話に出さない |
| Relay adapterを有効化して実Workerへdummy送信 | Sites/Workerの両端key/Origin/Bindingsに加え本番ログ/アクセス権の確認と**別承認** |
| Supabase OAuth認可、PC Agentの本番GUI操作 | 前段dummy実通信の確認のさらに後、本人OAuth/PCローカル承認を別ゲートで実行 |

Issue #29の4つのPC操作完成条件はすべて未検証・未達を維持する。

## 2026-10-20 保存版5 Hosted migrationネイティブ調査の結論（Work本人報告）

- WorkはSites保存版5 `4478d3490506340634a58a5b1403c02c97e5a41b`を変更せず、Siteネイティブ管理仕様・公開資料・保存されたPR #42 HEAD `edd66367`を調査したと報告。
- build artifactにSQLと**Drizzle journal**の存在を確認したが、これらは**Hostedに適用済みという証拠ではない**。Hosting migration履歴/チェックサム、同時実行・重複実行防止、transaction粒度、SQL途中失敗後のcommit状態、部分適用後のretry/repairは調べられる公式機能と文書から不明。
- OpenAI公式[Creating and using ChatGPT Sites](https://help.openai.com/en/articles/20001339-creating-and-using-chatgpt-sites)でDB変更がアプリ公開より先行して残り得ること、復元でコードしか戻らないことは明記される。詳細な内部migration保証は明記されず、**運用上の契約として確認できていない**。
- Work readbackでは現公開環境のD1 Binding 0、tables 0。旧保存版1のsource・archive・成功deploymentが存在し、正式な再デプロイ操作も提示されるが**実復元は未実行**。旧公開時のEnvironment revision `0`に対し現在の保存設定はrevision `5`。旧版の再デプロイを旧環境・Secrets・DBまで含む完全復元として扱わない。
- Work報告でPlus/Pro Sites hostingはプラン込み、SiteごとのDB上限10GB。**ユーザー固有の使用量・共有枠残量は未取得**で、他リソース・利用制限まで「無料・無制限」と認定しない。
- Work作成のOpenAI Support非機密問い合わせ案は**未送信**。質問事項：migration識別子/適用履歴参照、SQL/ファイルtransaction、SQL+履歴更新の原子性、4テーブル部分適用時の復旧とretry、同時deploy・重複防止、writeしないdry-run、コード復元後のDBとEnvironment取り扱い、Plus共有枠の表示/超過挙動。
- **次の唯一の外部対応:** ユーザーが[OpenAI Support](https://help.openai.com/en/articles/6614161-how-can-i-contact-support)の右下チャットから非機密の仕様質問を送付（チャットからの自動送信は未実施）。回答を記録し、確証が得られなければ、実際に確認可能な小規模初回DB作成・リリースの残余リスク/止め方を明示して別判断にする。質問待ちの間、保存版6作成・Hosted DB作成・Deploy・Secret変更・実Worker通信・実OAuth・PC操作は行わない。
- Issue #29の4完成条件は未達。現公開固定Plugin・Cloudflare Workerは変更なし。


## 2026-10-20 Hosted migration保証なしで進める前提と、ローカル再実行チェッカー（Claude実装・ローカル検証のみ）

**前提（ユーザー報告）:** OpenAIサポートへ問い合わせ済みで、Hosted migrationの内部保証（履歴・transaction・途中失敗後のretry）は**回答できない**と確認された。問い合わせは繰り返さない。したがって以後は「Hostedの保証はない」ことを前提にリスクを設計する。

**撤回:** 前回この節に書いた「runnerの挙動を問わず安全」は**撤回する**。下記ツールが示すのはローカルSQLiteでの結果だけで、Hosted runnerの安全は何も証明しない。

### ツール `gateway/cloudflare-callback-relay/tools/migration-safety.mjs` の保証範囲
| 区分 | 内容 |
| --- | --- |
| 判定できる（ローカルin-memory SQLite） | 追加のみか／先頭k文をコミット済みにした後で全文を再実行しても失敗せず同じ構造に収束するか／無関係な表の行が残るか／CHECK・DEFAULT・FK・UNIQUE・COLLATE・部分index・WITHOUT ROWID・view・triggerを含む構造指紋（`fingerprint()`）が変わるか |
| 判定できない | Sites/Cloudflare D1 runnerのtransaction範囲・履歴/チェックサム・同時deploy・SQLと履歴更新の原子性・D1固有挙動・単一文の途中失敗（SQLiteでは文は原子的と仮定） |
| **区別が必要** | `verdict: rerun_safe` は**再実行可能性だけ**。既存の同名表が期待構造かは**保証しない**。`IF NOT EXISTS` は別構造の既存表を黙って残す場合がある（出力 `existingSchema.sameNameDifferentShape[].sqlOutcome` が `silently_accepted`）。後続の文（例: 存在しない列へのindex）が失敗するとloudなエラーになるが、これは偶然であり互換性の保証ではない。常に `existingSchema.requiresRuntimeFingerprintCheck: true` とし、実行時に `fingerprint()` 相当で照合してRelay機能のみfail-closedにする必要がある |
| 指紋の性質 | sqlite_master.sqlの正規化文字列も含む保守的比較。見た目だけの違いを「差異」と判定し得る（fail-closed側）。文字列リテラルは大文字小文字を区別する |

SQLの解析は最小の字句解析（文字列・引用識別子・コメントを分離）で行い、`IF NOT EXISTS`の付与は文頭のCREATE TABLE/INDEXのコード部分に限る。文字列リテラル・コメント・引用識別子は改変しない（回帰テストあり）。字句を確定できないSQL（閉じない引用/コメント、`BEGIN`/`TRIGGER`/`CASE`を含む複合文）は推測せず `verdict: unsupported_sql` で拒否し、空DBで実行できないSQLも同様。拒否は「安全」ではなく「未判定」を意味する。

実行: `node --no-warnings=ExperimentalWarning tools/migration-safety.mjs --suggest <file.sql>`（終了コード0＝`rerun_safe`のみ）。出力は構造のSHA-256のみで、SQL本文は出さない。

### 対象の混同を避ける
- **Cloudflare Workerの `migrations/0001_relay.sql`（適用済み・変更しない）:** ローカル判定は追加のみ・データ保持OK・**`rerun_unsafe`**（途中適用k=1..5すべて再実行失敗）。`IF NOT EXISTS`化で`rerun_safe`になるが、Cloudflare側にも同化は不要で、wranglerの履歴が再実行をどう防ぐかは**当方未検証**。
- **Sites保存版5の4テーブルmigration:** 実SQLに当方はアクセスできず、**このツールは未実行＝検証未実施**。Work報告の「SQLite専用復旧・16状態」は引き続き報告ベースで、Hostedの保証ではない。

### Workの次の手順（読み取り＋ローカルのみ・実Hosted操作なし）
1. 保存版5の `dist/.openai/drizzle/**/*.sql` を上記ツールに通し、JSON（SQL本文なし）を記録。
2. `rerun_unsafe` なら`IF NOT EXISTS`化の未公開修正を作る。ただし`rerun_safe`でも1項の互換性は別問題。
3. Relay機能のみfail-closedにする起動時構造照合がSite側にあり、旧code+新schema／新code+未適用schemaでも`gateway_probe`が維持されることを確認（実Hostedではなくローカル/モックである旨を明記）。
4. **DB宣言なし初回Deploy案:** `.openai/hosting.json`から`d1`を外せばmigration自体が発生しない見込みだが、Sitesの実挙動は未検証。Sites側でのみ適用・確認可能。dummy通信にはSite側のpending/session保存が要るため、それを別の保存先にするか、D1宣言を後段に分ける設計はWorkが判断する。

### 初回Hosted Deployのリスクと止め方（実行は別承認、本節は計画のみ）
| リスク | 緩和（ローカル） | 止め方/復旧 |
| --- | --- | --- |
| migrationがlive切替前に適用され残る（公式Help明記） | 追加のみ・再実行可能なSQLのみを出荷 | コード復元はDBを戻さない。旧コードが新表を無視して動くことを事前にローカル/モックで確認。自動Down migration禁止 |
| 部分適用後のretry失敗 | `rerun_safe`判定 | 判定外（Hosted）の挙動は不明。失敗時は新たなdeployを乱発せずDB状態をreadbackしてforward-fixを別承認で判断 |
| 同名別構造の既存表 | 起動時の構造照合（Relayのみfail-closed） | Relay無効化、`gateway_probe`維持 |
| 費用・枠 | ユーザー側UIで承認前に確認 | 不明なら中止 |

これらはいずれも「ダミー通信へ進む前の障害を減らす」計画であり、Hosted上での成功を示すものではない。

## 2026-10-20 保存版5実SQLのWork検証: rerun_unsafeとschema照合見逃し

**根拠の区別:** 以下はChatGPT Workからユーザーが転送した**ローカル検証の報告**であり、この通常チャットからSites保存版5内部のSQLとテストログを直接取得していない。Sites/Cloudflare/Hosted DB/Secrets/PCの実設定は変更されていない。

- PR #42固定HEAD: `7cdd7abc2a111a260bd6d3164bee1cc49c5ca290`。Work報告ではmigration-safetyツールのGit blobと対象コミットの一致を確認。
- Sites未公開保存版5 `4478d3490506340634a58a5b1403c02c97e5a41b` の成果物にmigration SQL `dist/.openai/drizzle/0000_late_wong.sql` が**1件のみ**。Drizzle journal `idx:0`、4 SQL文。Workは保存ソースと成果物SQLの一致も報告。
- ツール結果（**local-sqlite-only**）: `verdict: rerun_unsafe`、`retryFailsAfter:[1,2,3,4]`、`nonAdditive:[]`、`convergeMismatch:[]`、`dataPreserved:true`、`validator_exit_code:1`。`dataPreserved`はツールが用意した**無関係テーブルの検証行**のみを意味する。
- `IF NOT EXISTS`を付与した**一時メモリ上の仮案**はローカル `rerun_safe` になるが、同名でschemaが異なるテーブルを黙って保持し得る。この仮案をSites保存版5へ適用していない。Hosted runnerの原子性・retry/履歴・本番復旧保証は依然不明。
- Workの既存schema照合は、通常の型不一致ならRelayを拒否・通信0で固定診断 HTTP 200を維持。しかし**引用列名内部の空白を正規化で削り、必須列が欠けた構造を一致と誤判定**する不具合を実際に再現。既存mock 13/13 PASSだが当該回帰例は検出できていない。
- 実Relay Adapterは現時点でHosted入口と未結線、Relay/実OAuthはOFF。本番dummy実通信も実行していない。

### Workでの次工程（未公開保存候補だけ、Hosted未操作）

1. **まずschema照合を最小修正:** 引用識別子・文字列を意味の変わる形で正規化しない。SQLiteの構造情報（例: `PRAGMA table_xinfo`、index/unique/foreign keyなど必要な情報）と宣言した期待schemaを比較し、必須列の欠落・別名・空白違い・型違い・index違いなどをfail-closedとして拒否。引用列名で見逃していた再現ケースの**修正前FAIL / 修正後PASS**を追加する。Relay機能のみOFFになり、固定 `gateway_probe` と既存HTTP応答は壊さない。
2. **続いてmigration:** `0000_late_wong.sql` が一度もHostedに適用されていないことを再確認。既存ソース/migration journalの正本関係・ビルド時の自動再生成・履歴の整合性を調べ、既存環境/Drizzle規則が許す場合だけ**未公開の次の保存候補**として、4 CREATEそれぞれの `IF NOT EXISTS` 化を評価。生成済み `dist/` を直接編集して完了扱いにしない。Journal/checksum/順序を勝手に偽造・削除しない。不明なら修正案で停止。
3. 仮案を保存した場合は保存前後の**成果物SQLと保存ソースが一致**することを再確認し、同じPR #42 `7cdd7ab`のローカルツールで再実行。部分適用16パターン（4テーブルの各有無）、same-name schema drift、旧/新コードと未適用/適用済みschemaの交差条件、DB/Secret未設定、Relay OFF、固定診断、POST owner/CSRFをmock/ローカルで検証し、テスト件数・実行環境・source commitを報告する。別ファイルを作成して過去migrationと衝突させない。
4. 復旧・承認前提: Hosted migration runnerは公式保証なし。Sites本番公開、D1生成、SQL適用、Secret変更/登録、実Worker通信、実OAuth、家PC操作、追加課金は**実施しない**。成功してもSites初回Deployは別途本人の明示承認が必要。

**次の結果を判断する基準:** 見逃し修正・回帰PASS・4文のlocal rerun検証・実成果物一致・既存固定診断互換・未公開保存コミットの提示。これは**本番の成功条件ではなく、公開候補レビューを再開できる最低条件**。Issue #29の4完成条件は引き続き未達。

## 2026-10-20 Sites保存版6: local replayとschema照合の不具合修正（未公開）

**証拠の境界:** ChatGPT Workからユーザーが転送した報告。通常チャットからSites内部の保存コミット `970c7ea993943a6a77cb2eda85112a230fa10fa9`、migration生成元、ビルド・CI/実行ログは直接読めていない。報告とGitHub readbackを混同せず、実Hosted成功と扱わない。

- **Site状態:** 保存版6 `970c7ea993943a6a77cb2eda85112a230fa10fa9` を**未公開保存**。現公開固定診断Site、Cloudflare Worker、Hosted D1、Secret、OAuth、家PCの実状態はWorkが変更していないと報告。
- **schema照合修正:** 引用された列名内の空白を保持し、SQLiteの列・制約・主キー・インデックス・外部キーの構造情報を照合。保存版5で不一致を見逃していた回帰が修正前FAIL→修正後PASS。schema不一致でRelay通信0・固定診断HTTP 200をWork mockで確認。
- **実migration:** 元の4つのCREATEを `IF NOT EXISTS`化。Drizzleのjournal/snapshotは**変更せず**、Drizzle生成によるschema差分なし、sourceとbuild artifactの内容一致をWorkが報告。保存版6の成果物はPR #42 `7cdd7ab`由来の `migration-safety.mjs`で**local-sqlite-only** `verdict:rerun_safe`、`statements:4`、`retryFailsAfter:[]`、`convergeMismatch:[]`、`dataPreserved:true`（テスト専用無関係テーブルの値）と判定。
- **検証:** Work報告で**53/53 tests PASS**、type/lint/build PASS、4テーブルの存在/欠落全16状態、既存検証行の保持、same-name異schema拒否、Relay初期OFF、DB/Secret未設定、旧固定診断の互換性を確認。実Hosted D1やWebブラウザで行ったテストではない。
- **未適用である根拠:** 保存候補が未公開、現公開版にD1宣言がなくWork readbackでBinding 0件という**状況証拠のみ**。Hosted側のmigration historyに直接照会できる保証はない。
- **未解決:** Hosted migration履歴・トランザクション・部分失敗後のretry/repairはOpenAI Supportでも非公開/無保証。 `IF NOT EXISTS`はschema driftを自動修復せず、schema guardの実ブラウザ/Hosted入口への結線・本番稼働は未検証。初回Deploy失敗後に旧コードへ復元してもD1/files/現envは戻らない。Cloudflare Relay `RELAY_SIGNING_KEY`のSites側登録、feature enable、実Worker dummy通信、OAuth、PC Agent E2Eは別ステップ。

### 次の作業は「追加実装」ではなく最終release go/no-go preflight（読み取り専用）

1. **保存版6の正本と現公開版を横に並べる:** 保存コミット `970c7ea`、現公開Version/Deployment IDと環境revision（旧版の当時のenvと混同禁止）、owner限定共有、Hosted Binding/SQL migration適用順、D1/Secret/Relay flagsを読み取り確認。変更なしで固定 `gateway_probe` が現行版の期待応答であることを確認。
2. **出荷candidateの最後のfail-closed条件:** 新コードがDB/Secret未設定または4表の部分状態なら既存診断を維持してRelayだけOFFになること、Hosted入口がadapterに未結線か接続フラグOFFであること、公開後も意図せぬOAuth開始やWorker外部アクセスが起きないことを成果物から再確認。公開直後に使う匿名化されたhealthy/unhealthy判定方法、即停止条件と旧コード再デプロイ手順を文書化。
3. **DB残存リスクを明記し残余リスクの受容可否を判断:** Sitesに正式read-only SQL履歴UIがないため、部分適用時の実DB復旧は保証できない。**「安全と証明済み」ではなく、このリスクを承認するかの判断**。Cloudflare/Secret/実Worker/OAuth/PCへの操作は独立承認を維持。
4. 最終preflight成功時だけ、**ユーザーへSite初回Deploy（D1新規provision/migration/既存固定診断の公開コード差し替えを伴い得る）を実施するか具体的に承認を依頼**する。承認前のDeployment・SQL適用・Secrets登録・現公開版差し替え・実Worker通信は禁止。Site初回DeployとRelay Secret登録/ダミー実通信を一括で自動実施しない。
5. Preflightを完了しても、**Issue #29の4条件は実機で確認されるまで未達**。Draft PR #42をmainへmergeしない。

**判断:** 保存版6は「mock/local検証済みのpre-deploy candidate」であって、Hosted migrationの成功確認でも全4完成条件の達成でもない。もし正式なrestore動線や使用量制限の重大不明点でfail-closed条件が確定できないなら、公開を保留する。
