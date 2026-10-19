# Issue #29 — Cloudflare Worker 安全な更新・ロールバック手順（dummy-only）

対象: `kaito-oauth-callback-relay-dummy` / PR #42。**本文は手順の設計と事前検査であり、Workerの配布、D1移行、OAuth承認、Sites公開を許可するものではない。** 実行前に本人の明示的な承認を得る。

## 0. 現状と変更禁止

- 実環境では signed prepare 201 → dummy callback 303 → claim 200 → replay 409を確認。現在のWorkerはdummy-only。
- Cloudflare APIの`worker_settings=disabled_observed`は可視ログ無効の観測であり、全内部ログ非保持の証明ではない。D1 Free Time Travelでは最大7日前までの暗号文が復元可能な場合がある。
- 旧Dashboard版の実行コードとPRの完全一致は未証明。今回はGitHub上のコード・ドキュメント・CIのみ変更する。
- 公開`gateway/cloudflare-callback-relay/wrangler.json`の`RELAY_ORIGIN=https://relay.example.invalid`とD1ゼロUUIDは**危険なプレースホルダー**。`wrangler deploy` / `wrangler versions upload`で直接使用しない。
- 本物のOAuth、Supabaseクライアント／redirect URI、Sites保存版2、Windows Agent、既存D1テーブル／Secretの変更は禁止。別途承認までGitHub Actionsはデプロイしない。

## 1. 既存本番状態の読み取り専用棚卸し（実デプロイ時に再実施）

本人アカウントにログインしたCloudflare Dashboardまたは正規の読み取り専用APIから、次を**同じ時点で**取得。API認証情報をChatGPT・GitHub・CIへ渡さない。

| 項目 | 期待値・停止条件 |
| --- | --- |
| Plan | Workers Free。課金／アップグレードなし。利用量・上限が不明なら停止 |
| Worker | `kaito-oauth-callback-relay-dummy`、`*.workers.dev`の既存公開先だけ |
| Deployments | 現在のDeployment IDと実行Version ID、配信割合100%を記録。対象不一致／splitなら停止 |
| D1 | 既存DB名・D1 UUID、Binding `DB`、3つのアプリテーブルとschemaを確認。新規作成・migration実行なし |
| Secrets | `RELAY_SIGNING_KEY`と`RELAY_STORAGE_KEY`の**名前と存在だけ**確認。値を読まない・登録し直さない |
| Variables | `RELAY_MODE=dummy`、既存Workerの正確なHTTPS originと一致する`RELAY_ORIGIN` |
| Cron | `* * * * *`（毎分）、既存のトリガーと一致 |
| Logs/Traces | OFF、Logpush OFF、tail consumerなし、OTel exporterなし。Script Settings公式readbackは`disabled_observed`などの観測を分けて記録 |
| Rollback | **更新前のactive Version ID**を実際のrollback候補として控え、Dashboardから選択できることを確認。確証がなければ配信変更禁止 |

Secretの値、API token、実際の`code/state`は記録しない。復旧用コードが存在しても古いDB schemaやBindingsと互換であるか別途確認する。

### 読み取り専用API検査（追加）

`gateway/cloudflare-callback-relay/tools/cloudflare-readback.mjs`で、Deploymentsの100%稼働Version IDを取得し、そのIDを指定してVersion情報を取得する。Cron/Script Settingsも公式GETで確認する。**Deploymentsを最後に再取得するため、実際のHTTP GET回数は合計5回**。途中で稼働IDが変われば未確認として停止する。VersionのBinding表現は公式仕様に合わせてオブジェクト・名前付き配列両方を受け入れ、日時付のcompatibility dateも比較できる。**GETのみ・API生レスポンスやSecret本文の出力禁止**。実行例はモジュール[README](../gateway/cloudflare-callback-relay/README.md#cloudflare実効情報の読み取り専用検査最新versionを固定して照合)を参照する。

`metadata_consistent`は認証済みAPIが返したメタデータの形と一部の固定条件が一致しただけであり、以下を**証明しない**:

- アップロード済みコードのバイト列がPR #42のソース/ビルド成果物と一致すること。
- Cloudflare内部アクセスログ、Edge/CDN、SitesのHTTP body、D1 Time Travel等の非保持。
- Freeプラン、残quota、ロールバック成功、実OAuthの安全性。
- 自動デプロイ承認またはVersion切替承認。

CloudflareのVersion detailの`resources.bindings`の形式が通常の配列でない場合は、Binding名確認が不明になり得る。値を表示して調べ直さず、公式UIの読み取りから別途照合する。既に前回の一時APIトークンは本人が無効化しているため、**再確認を実施する場合のみ新しい短期読み取り専用トークンが必要**。今は発行し直さない。

## 2. ローカル専用の候補設定

本人管理のローカルPCに、リポジトリ管理外の**非公開**`private-wrangler.json`と`private-baseline.json`を用意する。既存公開`wrangler.json`は編集しない。

- `private-wrangler.json`：公開`wrangler.json`を元に、originとD1 IDだけ実値へ差し替え、`keep_vars: true`を追加。Worker名、D1名、`workers_dev=true`、Cron、`RELAY_MODE=dummy`、ログ停止設定を維持。**Secret値を含めない**。
- `private-baseline.json`：読み取り専用のCloudflare棚卸しから、下記の**必要最小限の公開可能なメタデータのみ**を手元へ記録。Cloudflareからの応答を丸ごと保存しない。入力値は利用者が公式画面・APIで照合すること（自己申告JSONは暗号学的な証明ではない）。

例（文字列は説明用で、本番設定には使わない）:

```json
{
  "worker_name": "kaito-oauth-callback-relay-dummy",
  "worker_origin": "https://kaito-oauth-callback-relay-dummy.EXAMPLE.workers.dev",
  "database_name": "kaito-oauth-callback-relay-dummy",
  "database_id": "123e4567-e89b-42d3-a456-426614174000",
  "crons": ["* * * * *"],
  "active_version_id": "123e4567-e89b-42d3-a456-426614174001",
  "traffic_percent": 100,
  "secret_names": ["RELAY_SIGNING_KEY", "RELAY_STORAGE_KEY"],
  "plan": "free",
  "observed_at": "2026-10-19T14:00:00.000Z"
}
```

1時間より古い棚卸しは再取得。候補と現行リモート状態が変わった場合は作業停止。

### 候補設定のオフライン検査（ここまで自動化）

```powershell
node tools/deploy-preflight.mjs "C:\\private\\private-wrangler.json" "C:\\private\\private-baseline.json"
```

モジュール内にCloudflare HTTP通信・token操作・deployコマンドは存在しない。結果は固定booleanと判定だけで、入力JSONやファイルパス、Secretは出力しない。

- `blocked` = 変更禁止。
- `passed_offline_only` = **ローカル設定に矛盾を検出しなかっただけ**。`remote_state_authenticated=false`、`deploy_authorized=false`、`live_oauth_allowed=false`のまま。実装・バージョン一致・ロールバック可能性は別検証。
- 正式なビルドは`wrangler@4.128.0 deploy --dry-run --outdir .artifact`で実行。**必ずdry-runを維持**し、JS成果物SHA-256とソースcommitを一対一に記録。
- CIはSecrets/API tokenなしのビルドのみを行う。

## 3. 実際の更新（**未許可・現段階では実行禁止**）

将来本人が安全性・変更範囲を確認して明示的に承認した場合にのみ:

1. 変更直前に1章の棚卸しを再取得し、Cloudflare上の現行Version ID、Plan、D1、Secret名、Vars、Cron、ログOFFを比較。設定変化・トークン範囲・ロールバック不能・費用不明なら停止。
2. 固定したGitHub commitとdry-run成果物を確定。変更するのはCron失敗通知改善などの**dummy-onlyコード**で、schemaやD1 migrationは触らない。実OAuthコードを受け取らないことを検査。
3. 必要最小限の正規Cloudflare書込み権限を本人が承認した後に、ローカル非公開configを指定して **`wrangler versions upload --strict --keep-vars`** を検討。これでもクラウド上に新Versionを作る書込みなので、無承認では行わない。既存Secretを再入力しない。
4. 新VersionのID、Bindings、Vars、Cron、発行者・source、対応commit・artifact hashを確認する。**アップロード完了を本番稼働成功とみなさない**。必要であればVersion URLで無害なダミーのみを確認。URLの公開範囲と設定を事前確認。
5. 旧Versionへ戻せることを確認してから、本人が**配信切替を別途承認**した場合にのみ新Versionを配信。事前に記録したIDを必ず指定し、最初のロールアウトを100%かsplitか決める。勝手にトラフィック割合を変えない。
6. 切替後は同じVersion IDが配信されていること、実効Logs/Traces/Secrets名/Cron/D1バインディング、CPUとエラー、signed prepare→dummy callback→一回限りclaimの順で検証。D1暗号文消去とTTL削除も確認。これらは**実環境検証**であり、CI合格で代用しない。

## 2026-10-20 Cloudflare Dashboardの配信履歴・復元可否の読み取り確認

本人が開いたCloudflare Dashboardの **Settings / Deployments / Rollout history** の可視状態を、ChatGPT Browserのread-only機能で実際に確認した。GitHub上のローカルテストではなくクラウドDashboardの観測だが、認証済みVersion APIのメタデータ比較ではない。

- 対象Worker `kaito-oauth-callback-relay-dummy`、現在の稼働Version表示は **`61aeecd8`**、100%配信。更新履歴のメッセージは「更新されたシークレット: RELAY_SIGNING_KEY」。現在のSettingsには`RELAY_MODE=dummy`、固定`workers.dev` origin、Binding`DB`と既存D1、2つのSecret**名**、Logs/Tracesの親トグルOFF、毎分Cron、runtime compatibility date 2026-10-10 が表示された。Secret**値**は表示も取得もしていない。
- 一つ前に100%配信されたVersionの表示は **`e8e7d859`**（Wrangler）。さらに`62a1243d`、`7e1016ae`、`30e533df`、`83ef630c`、`b5dceedb`、`7b719f4d`、`1a869030`の100%配信履歴を確認。バージョン名はDashboard上の**先頭8文字**であり、Cloudflare API用の正確な36文字IDではない。
- Deployment一覧に現在のError Rate 0%、RPS 0、median CPU 1.57msと表示。トラフィックが無い瞬間の値なのでE2E稼働証明とは扱わない。古いVersionが存在しても実行可能なロールバックを保証しない。
- **重大な未証明点：** 現在版は署名用Secret更新を伴って作成されている。旧版に同じSecret値が有効かは隠されており確認不能。さらに旧版のコード/Binding名・型/D1接続先・Runtime設定・Cronの互換比較は未実施。過去の配信成功は現在のデータとSecretに対する適合証明ではない。
- **現時点の決定：`e8e7d859`を「安全なロールバック先」として登録しない。** 旧版への復帰操作を実行しない。古いSecretの再投入や値を画面/チャット/GitHubへ転記する試みもしない。
- 次の最小Read-only Evidenceは、Cloudflare Dashboardで稼働Versionと旧Versionの**個別バージョン詳細**（Secret値は伏せた状態）を確認し、Code/Bindings/Compatibility Date/D1接続先を比較すること。正規の短期`Workers Scripts Read` API資格情報を本人が後で承認した場合だけ、固定Version IDを指定した`GET /versions/{id}`を使う。いずれもSecret等値の同一性の証明にはならない。
- CodeのrollbackはD1の状態を巻き戻さず、CloudflareのRollbackは即100%配信となるため、将来の実行には別途明示承認が必要。[Cloudflare Workers Version](https://developers.cloudflare.com/workers/versions-and-deployments/) / [Rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) / [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。

## 4. 異常時のコードロールバック（**未許可・現段階では実行禁止**）

- 旧Version IDとそのBindings互換を再確認。別のVersionへ誤ロールバックしない。Cloudflare公式Dashboard > Workers & Pages > 対象Worker > Deployments > **旧VersionのRollback**、または本人が許可した`wrangler rollback <OLD_VERSION_ID> --name kaito-oauth-callback-relay-dummy`を使用。
- ロールバックは全トラフィックの稼働バージョンを直ちに変更するため、明示承認が必要。指定IDなしで「直前バージョン」を推測しない。
- ロールバックは**D1の中身・schemaや他のストレージを巻き戻さない**。D1復旧（Time Travel）はデータを上書きする別の高リスク作業であり、**自動実行しない**。
- 戻した後にVersion ID・署名検証・固定303・再取得拒否・Cron・ログ設定を改めて観測し、PC接続や実OAuthへ進めない。

## 5. 現在の停止条件（Issue #29）

1. Cloudflare現在のDashboard版コードとこのPRのコード全体の一致は**未証明**。
2. Cloudflare内部/CDN/Tail・Sites POST body等の非保持は**未証明**。D1 Time Travelは最大7日の暗号文履歴を保持し得る。
3. Sitesの正式OAuth統合と実OAuth対応の実装はまだ**行っていない**。dummy-onlyからのモード変更は別PR・別監査・本人承認。
4. ChatGPT通常チャット→Plugin→PC操作の4条件は未達。Desktop Commanderの本番依存禁止・家PCローカル承認・VALORANT Safetyを維持。

参考（公式）:
- [Cloudflare Versions & Deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)
- [Cloudflare Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/commands/workers/)
- [Wrangler Config](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
