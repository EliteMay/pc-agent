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

## GitHub保存とCI

- Draft [PR #42](https://github.com/EliteMay/pc-agent/pull/42)、branch `feat/issue-29-cloudflare-relay-dummy`。mainへのmergeなし。
- 実装commit `2f614cee900cdbad123ac26bdb8b0282ed28f15c`。追加19 filesのblobとbase既存108 filesをremote treeで照合し、一致/既存変更なし。
- 実装commitの[Callback relay dummy CI](https://github.com/EliteMay/pc-agent/actions/runs/38080984741) **success**、[既存Gateway CI](https://github.com/EliteMay/pc-agent/actions/runs/38080984742) **success**。
- Agent/Manager全体のテストは今回のmodule変更の範囲外で、実行済みとはしない。Cloudflare runtimeやログ非保持の検証とは別。
