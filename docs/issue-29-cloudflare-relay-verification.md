# Issue #29 — Cloudflare relay ダミー検証記録

2026-10-11 JST。正本は`docs/issue-29-cloudflare-callback-relay.md`、指定branchのblob `edb0e9111a7a86d1b7b2e81ca0bcf9205cfd1cc4`です。本記録は実装・検証Evidenceで、正本を置き換えません。

## 結果

- 新しい`gateway/cloudflare-callback-relay/`にdummy-only Worker、D1 migration、Sites server pull interface、実効ログ設定検査、no-deploy CIを追加。
- HMAC署名、永続nonce、owner/browser binding、300秒TTL、AES-GCM保管、原子的一回claimと暗号文消去、事前登録・rate limitを実装。
- callbackは固定queryなし303、`no-store`/`no-referrer`、cookie/bodyなし。Sitesにはraw callback URLを送らない。
- `npm test`: **36/36 PASS**。Worker20、Sites client12、logging policy4。20例のWorker testには並行claim、replay、rollback、期限切れ、ciphertext破損、署名/issuer不正、例外伏せ字を含む。
- `npm run check`: **PASS**、11 JavaScript modulesの構文とsource/config安全条件。Cloudflare runtimeのビルド・型検査ではない。
- 既存Sites保存版2の`node --no-warnings=ExperimentalWarning --test tests/*.test.mjs`: **20/20 PASS**。HEAD `63f617624ef192bc397e0b875eda5593bc3ac854`、作業ツリーclean、変更なし。
- 最初のWorker testsはfail-closed stubで17失敗、Sites clientは7失敗、logging validatorは1失敗を観測後に実装しGREEN。rollback testは既存transactionの追加検証として最初から成功。
- 独立した読み取りレビューでdummy-only版のblockerなし。36テストと11-module checkを再確認。追加probeでも同一nonceの同時claimは1成功/11拒否、rate窓更新後もactive cap5件を維持。
- Minor: rateは固定窓で、境界直前直後にprepare10回/claim40回を許し得る。文書で明示し、rolling interval化するかはlive統合前の判断へ延期。無料枠を攻撃から保証する制限とは扱わない。

## 確認した公式仕様

| 項目 | 確認結果 | 未確認 |
| --- | --- | --- |
| Workers Free | 100,000 requests/day、10ms CPU/invocation | 本人アカウントPlan、実Worker CPU・quota |
| D1 Free | 5M read rows/day、100k write rows/day、5GB | 実D1 runtime、index込み使用量、backup保持 |
| query redaction | 公式Script SettingsとWrangler4.128.0 releaseに存在 | 配置後の実効値・全プラットフォーム層の非保持 |
| log停止 | logs/invocation/persist/traces/destinations/Logpush/tail設定を明示 | account export、CDN/edge等の非公開範囲 |
| Sites通信 | HTTPS署名POST pull、queryなし固定復帰、owner/browser hooksをローカル検証 | 本人限定Sites上の正式接続・POST bodyログ |

## 変更していない対象

実OAuth同意・認可コード/トークン発行、Supabase OAuth App、Site source/保存版/Hosted Secrets/共有/本番deployment、Gateway、家PCに変更・通信なし。固定診断機能、4Secrets、本人限定認証、S256 PKCE、Windowsローカル承認を維持。Issue29の元の完成条件は未達。

## 次のゲート

1. 本人管理Freeアカウントと検証専用Worker/D1作成の許可。本人PCで異なる2鍵を生成し、公式UIへ直接投入。チャットへ送らない。
2. dummy-onlyのクラウド検証: script-settings実効値、D1 batch/RETURNING/`changes()`、同時取得、TTL/Cron、10ms CPU、見える全ログ/exportsのcanaryを確認。
3. 非公開Cloudflareログ、D1 backup、Sites POST bodyログの残る範囲を確認し、本人が許容判断する。設定一致/ログ0件だけを合格にしない。
4. 合格後の別許可でSupabase redirect追加とSites正式統合。保存版2pendingの暗号文内にraw stateを追加し、本人/ブラウザから安全に復元する。新旧callback URI、token交換redirect一致、4Secrets、固定probeを維持して再テスト・本人レビュー。
5. 本番deploy・本人OAuth同意・認証済み`gateway_probe`は未許可のまま。Windows操作はこのrelayの対象外。

詳細と公式根拠は[モジュールREADME](../gateway/cloudflare-callback-relay/README.md)へ集約。

## 2026-10-19 実環境追跡（ユーザー提示の実行結果）

**検証したものと未検証のものを区別する。** 以下は本人から提供されたPowerShell出力・Cloudflare管理画面の観測であり、本セッションのAIによるCloudflare API直接検査・デプロイ作業ではない。

| 対象 | 実環境の観測 | 限界 |
| --- | --- | --- |
| Free環境 | 本人管理Worker/D1、`RELAY_MODE=dummy`、Secret2件、Cron毎分、可視Logs/Traces無効 | 有料リソース未追加、内部の非公開ログは未確認 |
| ダミーHTTP | signed `prepare` 201、callback 303、固定リダイレクトとquery/body除去、claim 200、再claim 409 | 本物の認可コードでは未検証 |
| D1 claim | `phase=consumed` 1行で `envelope IS NOT NULL` は0、後日の再SELECTで3アプリケーションテーブルすべて0行 | DBバックアップ/Time Travel上の暗号文消去は保証されない |
| Cron | 22:21〜22:30の10実行は管理画面で成功表示 | 検証時配置コードはcleanup例外を捕捉しており、成功表示と削除の因果は未証明 |
| 公式Script Settings API | 読み取り専用トークンでGET成功、`worker_settings=disabled_observed`、`logpushDisabled=true` | `observability:null`では詳細のquery redactionやログ保存層を証明できない |
| Deployment API | デプロイメント取得成功、単一バージョンが100%配信、version metadata取得成功、`source=dash` | 実行バイナリの同一性は未検証 |
| Script Content API | `content/v2`成功、JS part1件、参照ソース3/3取得、`EXACT_RUNTIME_FILES=0/3` | デプロイ時結合/変換か内容差異か識別できず、version-pinned取得でもない |
| APIトークン | 本人から検証用トークンの無効化完了の報告 | 今後の認証付き追加確認は新たな正当な認証経路が必要 |

**残る実OAuth停止条件**:
1. 現在動作中のScript VersionとGitHubの審査済みビルド成果物の同一性が未証明。未証明を「一致」と言い換えない。将来の承認済み再配置時はローカルのビルド成果物ハッシュ・Deploy版ID・配置後readbackを同じリビジョンへ結び、変換がある場合は再現可能なビルドとArtifact比較を行う。
2. Cloudflareの非公開プラットフォームログ、Tailの過去利用、Sites側の署名付きPOST本文ログ、D1 Time Travel/バックアップの保持範囲は完全には観測できない。URLに認可コードが来る設計の残余リスクを、実認証を開始する前に本人が判断する。
3. 将来のlive対応は別変更・別レビュー対象。現行`RELAY_MODE=dummy`のまま、Supabase redirect URI、Sites認証情報や本番Workerへ変更しない。

**追加修正（本PRのコードのみ）:** `scheduled()`がD1 cleanup失敗を捕捉して`{cleanup_completed:false}`を返し、Cloudflare実行履歴が成功し得る問題を修正。失敗時は生のDBエラーを含まない固定`relay_cleanup_failed`例外でCron invocationを失敗させ、成功時は正常終了する回帰テストを追加。**現行Cloudflare配置済みWorkerには未適用**で、旧履歴は遡及して確証にならない。CI結果は該当コミットのGitHub Actionsで別途検証する。

## 2026-10-19 追補：再現可能なコード同一性検査の準備とOAuth残余リスク

**実施した新規コード（Cloudflare実環境の更新ではない）**

- `tools/artifact-identity.mjs`：Wranglerビルド済みJS partのSHA-256、ユーザーが認証取得した別ファイルとのローカルバイト比較。symlink、空/巨大ファイル、同一ファイル比較、無効な入力はfail closed。Cloudflare API接続、Token保存、コード本文出力はしない。
- `tests/artifact-identity.test.mjs`：ハッシュ安定性、同一/不一致、入力拒否、複数JS part時の未確定表示を回帰テスト。
- `callback-relay-ci.yml`：正式な`wrangler@4.128.0 deploy --dry-run --outdir .artifact`のみ実行して生成済みJSのSHA-256をCIログへ。CloudflareのAPI Secretを一切注入しない。**このWorkflowはデプロイしない**。
- 実行結果: commit `c47d1f2db29b0ddfd36e330eb275e9087ca0e1af`の[Callback relay dummy CI](https://github.com/EliteMay/pc-agent/actions/runs/39270733699)は46/46テスト成功、14 modulesの構文・設定チェック成功、Wrangler 4.128.0ビルド成功、生成JS partは1件。`single_part_sha256=8e12a5f90bd2856b038b54bd2e1325f2f658f08478c1cfbfd1dce35d1e71fd32`。[Gateway CI](https://github.com/EliteMay/pc-agent/actions/runs/39270733731)もsuccess。これは当該コミットでの**dry-run成果物**のdigestであり、稼働Cloudflareバイナリのdigestではない。
- 該当コードのCLI詳細と禁止事項は[モジュールREADME](../gateway/cloudflare-callback-relay/README.md#配置コードの同一性検査デプロイしない)を参照。

### 実OAuthに対するセキュリティ評価

| リスク | 根拠・現状 | 残る境界と対応 |
| --- | --- | --- |
| Cloudflare内部・edgeアクセスログへ`code/state`が残る | 実callbackはquery経由。管理者可視Workers Logs/Tracesは無効、APIは`observability:null`。リアルタイムTailは保存型Logsとは別機構。 | 非公開プラットフォーム/CDN/ネットワーク層のURL保持は検証不能。保存ゼロとは言わず、OAuth開始前にユーザーが残余リスクを明示判断。 |
| D1 Time Travelバックアップ | D1 FreeのTime Travelは有効で最大7日分遡って復元できる。active D1で`envelope=NULL`や行0を観測した。 | 過去の**暗号化**envelopeが復旧範囲内に残り得る。暗号鍵はWorker Secretへ限定、キー分離と300秒TTL/原子的claimを維持。全層即時削除とは表示しない。 |
| SitesサーバーのPOST本文・response記録 | signed `/claim`はHTTPSでcode/stateをSitesサーバーに返す。保存版2のホスト層実効ログ範囲は未確認。 | ブラウザ/MCPへcodeを出さず、Server内部のみ使用。Sitesのrequest body/responseログが実際に無いかは未確認。 |
| 実行コード相違・誤配布 | 旧Dashboard版`source=dash`、非Version固定の`content/v2`、GitHub3ソースと不一致。 | 新規CIでビルドSHAの正本候補を作成。ただしCloudflareの**稼働Version IDとそのコードを対応付ける証拠は引き続き未取得**。 |
| 無断実行・追加料金 | 公開されたcallbackがFreeのリクエスト制限を消費可能、レート制限は固定窓境界で短期burstを許す。 | Freeの100k/day等はサービス側のquotaであり、DoS耐性や追加料金0円の完全保証ではない。アカウントのPlan/Quota継続監視が必要。 |

**OAuth再開ゲート（未達）**：
1. 実OAuth対応コードの別実装・セキュリティレビュー・Testsを通す（現行はdummy-only）。PKCE S256/issuer/state、元の4 Secrets、本人のみ、同意、Windowsローカル承認を維持。
2. 許可した最終BuildのSHA-256と本番候補Deploy Version IDを紐づけ、既存Workerのrollback可能性、Cloudflareの実効ログ設定、Sites側の認証/本文経路を再確認する。
3. ログ/Time Travelの残余リスクを本人が確認・許容し、Supabase redirect URI変更、Sites統合、本番デプロイ、OAuth同意についてそれぞれ必要な実行承認を得る。

**運用上の重要な禁止事項：** 公開リポジトリの`wrangler.json`は`RELAY_ORIGIN=https://relay.example.invalid`とD1ゼロUUIDという**意図的なプレースホルダー**を使う。`--dry-run`を外して本番Workerを上書きしてはいけない。本人管理のDeployment設定を非公開で明示確認し、Secrets・Binding・Vars・Cron・Logs・Free費用・rollbackを個別にレビューした後でなければ実deploy禁止。

参考: [Wrangler bundling](https://developers.cloudflare.com/workers/wrangler/bundling/), [Cloudflareリアルタイムログ](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/), [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), [Script content API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/content/methods/get/)

## GitHub保存とCI

- Draft [PR #42](https://github.com/EliteMay/pc-agent/pull/42)、branch `feat/issue-29-cloudflare-relay-dummy`。mainへのmergeなし。
- 実装commit `2f614cee900cdbad123ac26bdb8b0282ed28f15c`。追加19 filesのblobとbase既存108 filesをremote treeで照合し、一致/既存変更なし。
- 実装commitの[Callback relay dummy CI](https://github.com/EliteMay/pc-agent/actions/runs/38080984741) **success**、[既存Gateway CI](https://github.com/EliteMay/pc-agent/actions/runs/38080984742) **success**。
- Agent/Manager全体のテストは今回のmodule変更の範囲外で、実行済みとはしない。Cloudflare runtimeやログ非保持の検証とは別。
- 2026-10-19の修正後HEAD `5f6e38270e970323af0049256f511432f9a0953f`で、[Callback relay dummy CI](https://github.com/EliteMay/pc-agent/actions/runs/39268885022) は **42/42テスト成功**、12 modules構文・安全性チェック成功。Cron失敗例外テストの実行もジョブログで確認。既存[Gateway CI](https://github.com/EliteMay/pc-agent/actions/runs/39268884638)の型チェックも成功。すべてGitHub CIであり、Cloudflareへは未デプロイ。

## 2026-10-19 安全なデプロイ・ロールバック準備（クラウド変更なし）

- [安全な更新手順](issue-29-cloudflare-deploy-runbook.md) を追加。CloudflareのVersion uploadと本番配信切替を区別し、旧Version ID・Bindings・Vars・Secrets名・Cron・ログ設定・Free利用量を更新前後で確認する。コードrollbackはD1を自動復旧しない。
- `tools/deploy-preflight.mjs` と`tests/deploy-preflight.test.mjs` を追加。ローカルの非公開候補configと、本人が公式UI/APIで取得した1時間以内のbaselineの整合性を検査。公開`wrangler.json`のダミーOrigin/D1 IDを拒否し、RELAY_MODE/live、余分なVars/Routes、Cron異常、Logs有効化、`keep_vars`未設定、Secret名異常、旧Version ID欠落、Free以外、baseline期限切れをfail closedにする。
- 検査は**完全にローカル**。API Token/secret値を取得・表示せず、`passed_offline_only`でも`remote_state_authenticated=false`、`deploy_authorized=false`、`live_oauth_allowed=false`のまま。自己申告baselineはCloudflare公式APIの真正性を自動証明しない。
- 実コードの追加コミット`cdccedd55c14fb17a581f542c0bc154468934d3d`の[Callback relay dummy CI](https://github.com/EliteMay/pc-agent/actions/runs/39272588946) と[Gateway CI](https://github.com/EliteMay/pc-agent/actions/runs/39272588685) success。runbook追加後の[Callback relay dummy CI](https://github.com/EliteMay/pc-agent/actions/runs/39272865076)では **50/50 tests PASS**、構文・安全性チェック16 modules PASS、Wrangler dry-runビルド成功、生成JS SHA256は`8e12a5f90bd2856b038b54bd2e1325f2f658f08478c1cfbfd1dce35d1e71fd32`。既存[Gateway CI](https://github.com/EliteMay/pc-agent/actions/runs/39272864995) success。
- **Cloudflare WorkerへのVersionアップロード・本番切替・rollbackは未実施**。Cloudflare実行版とPRコードの完全一致、内部ログ、Sites POST body保護、実OAuth/Supabase連携は未検証。本人の正式承認と安全性判断を要する。
