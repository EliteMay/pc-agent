# Cloudflare callback relay — ダミー検証版

Issue #29の[正本設計](../../docs/issue-29-cloudflare-callback-relay.md)を検証する独立モジュールです。`dummy-code-`形式しか受け付けず、実OAuth・token endpoint・Gateway・Windowsへの接続処理はありません。保存版2やHosted Secretsを変更しません。

## 通信と保管

1. Sitesの本人認証済みサーバーが、ownerとHttpOnlyブラウザセッションでpendingを読み込み、署名付き`POST /prepare`を送ります。
2. Workerがダミー`GET /oauth/callback?code=…&state=…`を受けます。未登録stateは保存しません。AES-256-GCM暗号文をD1へ保管します。
3. ブラウザへ固定の`303 https://kaito-pc-agent-web-bridge.kaito2526.chatgpt.site/connect/complete`を返します。query、body、cookieは空、`no-store`と`no-referrer`を付けます。
4. Sitesサーバーがローカルpendingを原子的に消費し、署名付き`POST /claim`のbodyでstate/bindingを指定します。Workerは一回だけ返し、同じD1トランザクション内で暗号文を消去します。
5. サーバー内の`exchangeDummy`モックへ元のPKCE verifierとWorkerのredirect URIを渡します。ブラウザは有限の状態だけを受け取り、Gateway成功とは表示しません。

HMAC-SHA256はorigin、POST、path、Unix時刻、nonce、body digestを署名します。時刻差30秒、永続nonce90秒、pending300秒です。署名されたprepareを固定10分窓で5回、active pendingを5件、claimを固定1分窓で20回に制限します。窓の境界では短時間にprepare10回/claim40回を許し得ます。rolling intervalの上限ではなく、live統合前に採用基準を確定する必要があります。D1 Cronで毎分失効行を削除し、Cron前でも期限切れを拒否します。**このブランチで修正後のCron**はD1削除失敗を握りつぶさず、固定文字列`relay_cleanup_failed`の例外で実行を失敗として報告します。元の配置済みWorkerには未反映のため、過去のCron履歴「成功」だけでは削除処理の成功を保証しません。

`src/sites-client.mjs`はサーバー専用の接続インターフェースです。`authorize`は既存Sitesの信頼されたdispatch本人認証、`loadPending`は本人・HttpOnlyセッション照合、`consumePending`は条件付きDELETE等の原子的処理を必須とします。テストの`x-test-owner`を本番認証に流用しません。保存版2はstate digestのみなので、将来の正式統合時にraw stateを既存の暗号化pending envelope内へ追加する必要があります。raw stateをURLやブラウザから復元しません。

## ローカル検証

Node.js 24のみ。依存パッケージ・Cloudflareログイン・秘密値・ネットワーク通信は不要です。

```sh
cd gateway/cloudflare-callback-relay
npm test
npm run check
```

テストは実際のSQLite migration/SQL、Web Crypto、独立したNode HMAC署名を使います。D1 adapterはローカルSQLiteです。Workers runtime、D1 APIでのRETURNING/batch/`changes()`の動作、Freeの10ms CPU制限は未検証です。型チェックやCloudflareビルド成功とは主張しません。CIは同じローカルテストのみでdeployしません。

## 配置コードの同一性検査（デプロイしない）

Cloudflare Dashboardから取得したコードとGitHubの`src/worker.mjs`等の**ソースファイルを直接比較しても**、Wrangler/esbuildによる結合・変換があるため一致証明になりません。今回追加したCIは、**Wrangler 4.128.0を指定してビルドだけ**を行い、結合済みJS partのSHA-256を表示します。Secret/Account IDは不要で、CIにCloudflareの認証情報は与えません。

```sh
cd gateway/cloudflare-callback-relay
npx --yes wrangler@4.128.0 deploy --dry-run --outdir .artifact
node tools/artifact-identity.mjs fingerprint-dir .artifact
```

`--dry-run`を消して実行しないこと。上記は`wrangler.json`内の意図的なダミーorigin・D1 IDプレースホルダーのまま、**ローカルのコードだけ**をビルドします。`single_part_sha256`はビルドしたJSのSHA-256であり、デプロイ同一性の証明ではありません。比較用にCloudflareのJS partを正当な読み取り専用APIでユーザーPCへ安全に取り出せた場合だけ、秘密情報のない別々のファイルとして次を実行できます。

```sh
node tools/artifact-identity.mjs compare-files <build-js> <cloudflare-js>
```

このコマンドはファイルを読み取るだけで、2ファイルのバイト列が異なると終了コード1を返します。秘密情報・本文・パスは出力しません。同一でも`active_deployment_verified=false`、`live_oauth_allowed=false`を固定出力します。

**実稼働バージョンの同一性確認は別ゲート：** 認証済みCloudflare Deployments APIで実行中Version ID・割合を直前/直後に取得し、途中で変更がないことを確認。一般的な`content/v2`読取はVersion固定ではないため、これ単独では「このVersionのバイナリ」と断定しません。現在のDashboard配置版はソース/ビルド手順が未確定なので、PRのビルドSHAと異なっても不正実装の証拠にはなりません。**Cloudflareへの上書き・Wrangler deployは別途本人承認が必要**です。CloudflareのAPI認証情報やWorker SecretをGitHubに登録しません。

参考: [Cloudflare Bundling](https://developers.cloudflare.com/workers/wrangler/bundling/) / [Wrangler dry-run](https://developers.cloudflare.com/workers/wrangler/commands/workers/) / [Worker Script Content](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/content/methods/get/)。

## 既存Cloudflare Workerを上書きしない更新準備

現在の運用手順は [安全な更新・ロールバック手順](../../docs/issue-29-cloudflare-deploy-runbook.md) が正本です。現在のWorkerに対する実デプロイ・バージョンアップロードは**未許可**です。Cloudflare公式のVersions/Deploymentsで新Versionのアップロードと配信切替を分け、旧Version IDを保全し、D1復旧がコードロールバックと別であることを確認します。

手元の**非公開**候補configと、Cloudflare公式UI/APIで直前に観測した必要最小限のbaselineを使うオフライン検査のみ追加しています。ダミーorigin・D1ゼロUUIDを含む公開`wrangler.json`は通しません。

```sh
node tools/deploy-preflight.mjs <private-wrangler.json> <private-baseline.json>
```

候補は`keep_vars=true`、現行のWorker名/Origin/D1/Cron/Secrets名、ログ停止の意図、dummy modeと一致しなければfail closedです。baselineは1時間以内のデータに限定します。CLIはCloudflareに接続せず、入力内容や秘密値を出力しません。`passed_offline_only`でもリモート真正性・旧Versionのrollback可否・実コード同一性・本人承認は**未検証**で、`deploy_authorized=false` / `live_oauth_allowed=false`を維持します。

## Cloudflare実効情報の読み取り専用検査（最新Versionを固定して照合）

`tools/cloudflare-readback.mjs`は本人が管理するWorkerの以下の**4種類の公式GET API（合計5回）**のみを利用します。コードや設定の更新はできず、デプロイコマンドも実装していません。

1. `GET .../deployments`から現在100%配信のVersion IDを抽出。splitや欠落は停止。
2. `GET .../versions/{version_id}`で**そのVersionに紐づく**メタデータを確認。対応Version ID、Runtime日時（Cloudflareの日時付き形式も許容）、fetch/scheduled handler、確認可能なBinding**名だけ**検証。Bindingがオブジェクト形式と名前付き配列形式のどちらでも固定名だけ抽出し、未知形式は未確認扱い。
3. `GET .../schedules`で実効Cronを確認。
4. `GET .../script-settings`でLogs/Traces設定・Logpush・Tailを確認。
5. `GET .../deployments`を再取得し、監査中に稼働Version IDとDeployment IDが切り替わっていないことを確認。途中変更は`unverified_deployment_changed`で停止。

使用時だけ本人PCで一時的な`Workers Scripts Read`トークンを用意し、Nodeプロセスの環境変数`CLOUDFLARE_API_TOKEN`と`CLOUDFLARE_ACCOUNT_ID`から読み込みます。**トークンをコマンド引数、ChatGPT、GitHub、CI、ログ、ファイルに入れないこと。** 既に無効化した前回トークンは再利用できません。トークンは短い有効期限・単一アカウントに限定し、検査後すぐ無効化します。

以下はWindows PowerShellでの安全な入力例です（実行する場合はリポジトリの当該モジュールに移動し、アカウントIDは本人のDashboardから確認して入力）。

```powershell
$secure = Read-Host "Cloudflare read-only token" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:CLOUDFLARE_ACCOUNT_ID = "ACCOUNT_ID_FROM_DASHBOARD"
  $env:CLOUDFLARE_API_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  node tools/cloudflare-readback.mjs
} finally {
  Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}
```

結果は`readback`、検査名と真偽値、有限ステータスだけです。バージョンID、Binding値、Secret/Token、HTTPエラー本文、取得したJSONを**一切出力・保存しません**。`metadata_consistent`でも`active_version_binary_identity=unverified`、`platform_log_scope=unverified`、`free_plan_verified=false`、`deploy_authorized=false`、`live_oauth_allowed=false`を維持します。Cloudflare APIのBinding情報の形式が不透明／許可不足なら`unverified`のまま扱い、推測で検証済みにしません。

最新Version情報はコンテンツ取得元を固定するための補助証拠であり、**コードのSHA-256と稼働Version IDの暗号学的な同一性証明ではありません**。実Cloudflare接続とログ非保持の保証は別途確認が必要です。

公式仕様: [Deployments API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/)、[Versions API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/)、[Cron API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/schedules/methods/get/)、[Script Settings API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/settings/methods/get/)。

## ログ保護の検証条件

`wrangler.json`には`observability.redact_query_string=true`と、observability・invocation logs・logs/traces永続化・destinations・Logpush・tail consumersの無効化を明記しました。Wrangler **4.128.0**でquery redactionが追加されたことを[公式release](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.128.0)で確認済みです。この環境ではWranglerを取得・実行していません。

設定ファイルは意図です。本人管理の検証Worker作成後、公式APIの

`GET /accounts/{account_id}/workers/scripts/{script_name}/script-settings`

で実効値を確認します。API token・生responseをチャットやGitHubへ出しません。取得したJSONは本人環境で次へpipeでき、結果は固定ラベルとbooleanのみです。

```sh
node tools/verify-log-settings.mjs < private-effective-settings.json
```

**実環境の観測（2026-10-19、本人提供の実行出力）:** `script-settings`公式GETは成功し、`worker_settings=disabled_observed`、`logpush=false`相当を確認しました。`observability:null`の状態では個別のredaction/logs/tracesの実効値は取得できないため、`platform_log_scope`と実OAuth許可は引き続き未検証です。`content/v2`も読み取り成功しましたが、Cloudflareに配置された単一JS部分とGitHub上の3ソースの文字列は完全一致せず、Dashboardによるコード結合の可能性を排除できません。`ACTIVE_VERSION_BINARY_IDENTITY`は未証明であり、別の配置コードとの差異の可能性も残ります。本人は検証用APIトークンを無効化済みと報告しています。詳細は検証記録を参照してください。\n\n`matched`は入力がWorker設定方針に一致した意味だけです。取得元の真正性、全Cloudflare層の非保持、SitesのPOST bodyログ、実OAuth許可は証明しません。省略値は安全と推定せず`unverified`、`live_oauth_allowed`は常にfalseです。通常の`npm run check`はplaceholderを含む未配置設定を検査するため、実アカウント用の変更は別の本人管理deploy設定へ分離します。

## 本人の操作が必要になる次の段階

- 本人管理Cloudflare **Free**アカウントを確認し、検証専用Worker/D1の作成を許可する。未保有なら本人が作成する。Paid化・課金資源は使わない。
- 正式なWorker origin/D1 IDを確定し、署名用`RELAY_SIGNING_KEY`と暗号化用`RELAY_STORAGE_KEY`を、互いに異なる32-byte base64url鍵として本人PCで生成し公式Secrets UIへ投入する。鍵をチャットに貼らない。署名鍵は将来Sites側にも必要だが、今回Sites Secretsは変更しない。WorkerへOAuth client_secret、service_role、家PC鍵は置かない。
- **dummy modeのまま**実効設定readback、ダミーcallback、同時claim/rollback/TTL、CPU使用量、閲覧可能なログ・trace・転送先を確認する。code/stateだけのcanaryを使い、authorize/tokenを呼ばない。ログ0件だけを非保持証明にしない。
- 管理者可視ログ以外のCloudflare/CDN等の範囲、D1バックアップの暗号文保持、Sitesの署名POST body/responseログを確認する。残る未確認範囲と許容水準を本人が判断する。

ここまで合格後にのみ、別の明示許可でSupabase redirect URI追加、Sites保存版2への正式統合・Secret追加・テスト・本人レビューへ進みます。本番再deployや本人OAuthは別のゲートです。既存callback、固定診断、4Secrets、本人UUID検証、PKCE S256、Windowsローカル承認を維持します。

## Free枠と限界

2026-10-11 JST確認: Workers 100,000 requests/day・10ms CPU/invocation、D1 5,000,000 rows read/day・100,000 rows written/day・5GB合計。index更新も行数に算入されます。Cronは最大1,440回/日で、1接続はprepare/callback/claimの3リクエストです。追加のAPI確認や攻撃リクエスト、同アカウントの他用途も枠を使うため、この計算だけで枠内を保証しません。超過や設定不明は停止し、自動Paid移行しません。

削除はactive D1行の消去です。バックアップ/Time Travelの即時全消去は保証しません。公開callbackへの大量アクセスでFree quotaが枯渇する可能性も残ります。live対応、実ログ保護、Sites正式統合は未完了です。

- [Workers料金](https://developers.cloudflare.com/workers/platform/pricing/)
- [D1料金](https://developers.cloudflare.com/d1/platform/pricing/)
- [Script settings GET](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/settings/methods/get/)
- [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [検証記録](../../docs/issue-29-cloudflare-relay-verification.md)

## 2026-10-25 実OAuthモードのソース実装（デフォルトOFF・未デプロイ）

**本READMEの従来の「dummy-only」は実環境と既定設定について引き続き正しい。** PR #42の未公開ソースには、将来の実OAuth連携用の**明示的なopt-in**経路を追加した。これは公開承認でも運用設定変更でもない。

### 現在実装したサーバー側の経路

- Cloudflare Workerの既定 `RELAY_MODE=dummy` は維持。実OAuth受理にはServer-side config **`RELAY_MODE=live` と `RELAY_LIVE_ENABLED=true`（文字列）両方**が必要。片方だけ・未知の設定・署名鍵/暗号鍵/D1欠落は503 `setup_required`。**実OAuth時はさらに `RELAY_ORIGIN` が既存の `https://kaito-oauth-callback-relay-dummy.k12m45k.workers.dev` と一致する必要があり、テスト専用 `relay.example.invalid` はWorker・Sites側の両方で拒否する。** オフライン検証はその本番URL識別子を使ったモックで行い、ネットワーク接続しない。この2値は運用承認を代行しない。
- Workerの`/prepare`→`GET /oauth/callback`→`/claim`は既存のHMAC署名・Origin固定・D1暗号化・期限300秒・rate制限・一回限りclaim・queryなし303を再利用する。実モードは`oauthCode`でのみ認可コードを受け入れ、ダミーコードを拒否。認可拒否は従来の有限な`denied`結果に正規化する。
- **DB schema変更なし**で、実モードの`state_hash`を`SHA256("kaito-relay|live|"+state)`へ名前空間分離。暗号化AADにもmodeを束縛する。既存dummy行は以前と同じHash/AADのまま。モード変更前のpendingが別モードのcallback/claimへ渡ることを防ぐ。
- Sites参照`createSitesRelayClient`は既定`mode='dummy'`、実モードは`mode='live', liveEnabled=true, exchangeOAuthCode`（server-only callback）の明示設定を要求。GET完了は禁止、同一Origin+CSRF付きPOSTのみpendingを一回消費する。Workerとprepare responseのmode不一致や戻り値schema異常は503で停止する。callbackは**生のaccess/refresh tokenをブラウザへ出さない**。
- 実トークン交換のHTTP処理はここで複製しない。保存版10のSitesが持つ **confidential client + PKCE verifierを利用した既存のserver-only交換処理**を`exchangeOAuthCode` callbackとして注入する。トークン保管・本人認可はSites側の既存権威境界に残す。

### 本番対応前に必須の接続確認

1. 正式なSites管理操作で**保存版10の実サーバー側ソース**を取得し、`GET /connect/complete`が表示専用、`POST /connect/complete`が本人セッション/Cookie/Origin/CSRFでconsume+claimすることを照合。正しい`authorize`の`redirect_uri`・保留状態の`redirectUri`・confidential PKCEのtoken交換`redirect_uri`が、登録済みWorker固定URL `<RELAY_ORIGIN>/oauth/callback` と完全一致するか検査する。実Siteへのコード取り込み・公開は**別途承認**。
2. Cloudflareの現行配信ソース・Secret共有・ログ残留リスク・D1・旧Versionを正式管理の読み取りで再確認し、実OAuthの許可/互換性とロールバックを評価。既存D1 pendingを十分に失効させてからモード切替。
3. Supabase OAuth confidential登録とのSite Secret ID一致、旧Pluginクライアントへの影響、PR #47 Gatewayのクライアント別認可を確定。**旧Gatewayを無制限で残してSite用トークンを発行しない。**
4. 本番変更・OAuth consent・PC commandは別々の本人明示承認が必要。無害な認証済みprobe→relay_ping→PCへの一回限りのping→画面/GUI実証の順で進める。

**制限:** 実OAuth codeの実環境形式は未実測。現`oauthCode`は文字数1〜512の保守的URL-safe文字だけを許可するため、Supabaseの実発行値がこのsubset外なら拒否になる。その場合、実値をログへ出さず、公式仕様/安全な分類だけからvalidatorを調整する。ダミーモードの成功やCIのモックテストを実OAuth/Windows PCの接続成功と数えない。

**実施しなかった操作:** 本番Worker Deploy、`RELAY_MODE`/`RELAY_LIVE_ENABLED`の設定変更、Sites保存・公開、Secret/DB/OAuth callback登録、実認可コード・token発行、PC操作。
