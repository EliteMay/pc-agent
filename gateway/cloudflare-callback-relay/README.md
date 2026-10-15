# Cloudflare callback relay — ダミー検証版

Issue #29の[正本設計](../../docs/issue-29-cloudflare-callback-relay.md)を検証する独立モジュールです。`dummy-code-`形式しか受け付けず、実OAuth・token endpoint・Gateway・Windowsへの接続処理はありません。保存版2やHosted Secretsを変更しません。

## 通信と保管

1. Sitesの本人認証済みサーバーが、ownerとHttpOnlyブラウザセッションでpendingを読み込み、署名付き`POST /prepare`を送ります。
2. Workerがダミー`GET /oauth/callback?code=…&state=…`を受けます。未登録stateは保存しません。AES-256-GCM暗号文をD1へ保管します。
3. ブラウザへ固定の`303 https://kaito-pc-agent-web-bridge.kaito2526.chatgpt.site/connect/complete`を返します。query、body、cookieは空、`no-store`と`no-referrer`を付けます。
4. Sitesサーバーがローカルpendingを原子的に消費し、署名付き`POST /claim`のbodyでstate/bindingを指定します。Workerは一回だけ返し、同じD1トランザクション内で暗号文を消去します。
5. サーバー内の`exchangeDummy`モックへ元のPKCE verifierとWorkerのredirect URIを渡します。ブラウザは有限の状態だけを受け取り、Gateway成功とは表示しません。

HMAC-SHA256はorigin、POST、path、Unix時刻、nonce、body digestを署名します。時刻差30秒、永続nonce90秒、pending300秒です。署名されたprepareを固定10分窓で5回、active pendingを5件、claimを固定1分窓で20回に制限します。窓の境界では短時間にprepare10回/claim40回を許し得ます。rolling intervalの上限ではなく、live統合前に採用基準を確定する必要があります。D1 Cronで毎分失効行を削除し、Cron前でも期限切れを拒否します。

`src/sites-client.mjs`はサーバー専用の接続インターフェースです。`authorize`は既存Sitesの信頼されたdispatch本人認証、`loadPending`は本人・HttpOnlyセッション照合、`consumePending`は条件付きDELETE等の原子的処理を必須とします。テストの`x-test-owner`を本番認証に流用しません。保存版2はstate digestのみなので、将来の正式統合時にraw stateを既存の暗号化pending envelope内へ追加する必要があります。raw stateをURLやブラウザから復元しません。

## ローカル検証

Node.js 24のみ。依存パッケージ・Cloudflareログイン・秘密値・ネットワーク通信は不要です。

```sh
cd gateway/cloudflare-callback-relay
npm test
npm run check
```

テストは実際のSQLite migration/SQL、Web Crypto、独立したNode HMAC署名を使います。D1 adapterはローカルSQLiteです。Workers runtime、D1 APIでのRETURNING/batch/`changes()`の動作、Freeの10ms CPU制限は未検証です。型チェックやCloudflareビルド成功とは主張しません。CIは同じローカルテストのみでdeployしません。

## ログ保護の検証条件

`wrangler.json`には`observability.redact_query_string=true`と、observability・invocation logs・logs/traces永続化・destinations・Logpush・tail consumersの無効化を明記しました。Wrangler **4.128.0**でquery redactionが追加されたことを[公式release](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.128.0)で確認済みです。この環境ではWranglerを取得・実行していません。

設定ファイルは意図です。本人管理の検証Worker作成後、公式APIの

`GET /accounts/{account_id}/workers/scripts/{script_name}/script-settings`

で実効値を確認します。API token・生responseをチャットやGitHubへ出しません。取得したJSONは本人環境で次へpipeでき、結果は固定ラベルとbooleanのみです。

```sh
node tools/verify-log-settings.mjs < private-effective-settings.json
```

`matched`は入力がWorker設定方針に一致した意味だけです。取得元の真正性、全Cloudflare層の非保持、SitesのPOST bodyログ、実OAuth許可は証明しません。省略値は安全と推定せず`unverified`、`live_oauth_allowed`は常にfalseです。通常の`npm run check`はplaceholderを含む未配置設定を検査するため、実アカウント用の変更は別の本人管理deploy設定へ分離します。

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
