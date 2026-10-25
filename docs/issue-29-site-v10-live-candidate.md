# Issue #29 — 保存版10向け実OAuth Relay未公開ソース候補

状態: **GitHub PR #42のソース候補のみ**。Sitesへの未公開保存、公開Deploy、OAuth有効化、Supabase登録変更、PC操作は未実施。

## 根拠とスコープ

- ユーザーの2026-10-25の正式Sites読み取り報告: 公開保存版10、環境revision 5、本人限定共有、コミット`02f16ae4…`。この通常チャットには正式なSites source取得/書込み機能が無く、**該当コミットの全文を独立再取得・行単位で照合してはいない**。
- 同報告によると`bridge.mjs`のGET `/connect/complete`は表示用・queryなし303、POSTは本人/Cookie/Origin/CSRF後に単回claim。現行の実装は直接OAuthとdummy Relayのみでlive Relayは未結線。既存の直接OAuth側にはPKCE S256、暗号化pending、server-only交換/暗号化トークン保存がある。
- [PR #42](https://github.com/EliteMay/pc-agent/pull/42)の`gateway/cloudflare-callback-relay/src/site-v10-live-candidate.mjs`を**新規**追加。Site本体の不明なDB列名や内部APIを推測して書き換えず、既存のserver-only関数を注入する境界アダプターにした。

## 既存Sites保存版10と接続するときのサーバー側責務

`createSitesV10LiveCandidate`の引数は、**既存のSitesのserver-only処理**で実装する。

| 注入引数 | 既存Sites側で使う正規処理 | 必須契約 |
| --- | --- | --- |
| `authorize(request)` | 正式な本人セッション/所有者チェック | ヘッダーをブラウザ入力だけで信用しない。browser/MCP本人一致は実測まで未証明 |
| `loadPending(request,owner)` | HttpOnly Cookie＋ownerで暗号化pendingを復号してロード | `mode:'live'`、`owner`、`browserId`、`state`、`verifier`、`csrf`、`expiresAt`、固定`redirectUri`を返す。D1 schemaの変更を推測しない |
| `consumePending(pending)` | 既存のDB単回消費 | 並行POSTでも1回だけtrue、値をブラウザに返さない |
| `invalidatePending(pending)` | 既存の失敗時無効化 | 再送で再利用できない |
| `buildExistingAuthorizationUrl(request,pending)` | 既存PKCE S256/機密clientによる認可URL生成 | `state`、`client_id`、`redirect_uri`、実verifierのSHA256 challenge一致を検証後にのみ利用 |
| `exchangeAndStoreExistingOAuth({code,state,code_verifier,redirect_uri})` | 既存Supabase Token endpointへのサーバー交換と暗号化保存 | 既存confidential client secretをサーバー内に保ち、tokensやcodeをUI/ログに出さない |
| `oauthClientId` / `key` | 既存のHosted Secret（server-only） | 実値はGitHub/チャット/Browserへ表示しない。Supabase登録との非公開等値照合が必要 |
| `enabled` | 信頼済みサーバー側feature gate | **デフォルトfalse**。ブラウザ/MCP要求でONにできない。Work未公開候補でもOFF保持 |

### ルートの組み込み順

1. 保存版10の既存直接OAuth開始処理のうち、**認証済みの本人ブラウザーにmode='live'のpendingを暗号化保存する部分のみを再利用**する。dummy codeは生成しない。既存の直接OAuth callbackやトークン暗号化処理を破棄しない。
2. 同じ信頼済みrequestで候補`start(POST /oauth/start)`を呼ぶ。候補は既存pendingのowner/CSRF/有効期限と認可URLの`state`、`code_challenge_method=S256`、実verifierのSHA256、`client_id`、固定Worker`redirect_uri`を照合する。その後、署名付きWorker`/prepare`が201を返す場合だけSupabase OAuth認可URLへ303。
3. 認可成功/拒否時にSupabaseからWorker`GET /oauth/callback`へ来るcode/stateは**Workerだけ**で受ける。Workerが暗号化pending保存し、query無し303でSites`GET /connect/complete`に戻る。Sites GETは候補`getComplete()`でホームへ303するだけでconsume/claimしない。ブラウザーに再認可codeを載せない。
4. 既存の本人限定UIからCSRF付き`POST /connect/complete`で候補`postComplete()`を呼ぶ。候補内の既存`createSitesRelayClient`は単回consume、署名付きclaim、既存`exchangeAndStoreExistingOAuth`を実行する。成功レスポンスは`{state:'checking', mode:'live', gateway_authenticated:false}`なので、**UIは認証済みと表示せずGatewayの別途確認を要求**する。dummy`checking`表示との互換に注意。
5. 既存`gateway_probe`はOFF状態で固定診断のまま。Gateway呼び出し可能にすることと、実OAuth pending/codeの受渡しは別のrelease step。Site本人/MCPヘッダー真正性とPR #47のverified `client_id`は別ゲートとして維持する。

## 今回の開発ブランチで証明できること／できないこと

- Nodeの実Worker/D1互換mockでの`POST start → PKCE認可URL検査 → Worker callback → GET非消費 → CSRF検査 → POST claim → mock token交換`が成功し、access/refresh tokenはブラウザに露出しない。
- 不正`redirect_uri`、Client ID、state、code_challenge、method、owner/Cookie/Origin/CSRF、dummy pending、不正GET/再試行は拒否。既存dummyテストを維持。
- **実Sites保存版10内で動くか／Client ID一致／Cloudflare active artifact／本番Supabase redirect登録／実User header真正性は未検証。** Hosted実行証明ではない。

### 最も近い本番ブロッカー

- 実Supabase confidential OAuth Clientの登録redirectは既存Site `/oauth/callback`のみで、Workerの`https://kaito-oauth-callback-relay-dummy.k12m45k.workers.dev/oauth/callback`は**未登録**（2026-10-25の読み取り専用集計）。登録変更は**別途明示承認**が必要。既存Site callbackを勝手に削除しない。
- Sites`02f16ae4…`の正式なWritable sourceを再取得できたときだけ、同じ内部関数／DB Schemaを使う小差分で未公開保存し、GET/POST/owner/UIの38件以上の既存テストと候補テストを走らせる。今回は当該Siteへのsaveはしていない。
- 本番Worker/Gateway deploy、Cloudflare/Supabase Secret変更、実OAuth/consent、PCコマンドは**今回の許可対象外**。

## 2026-10-25: 認可URLとRelay prepare間の競合対策（source-only）

追加監査で`createSitesV10LiveCandidate.start()`が初回`loadPending`でPKCE認可URLを生成した後、`createSitesRelayClient.prepare()`内で**同一ブラウザーpendingを再読込**することを確認。タブ競合やSession state置換があると、認可URL側の`state/verifier`とWorkerに署名・登録したpendingが**別の状態になる**可能性があった。

**対策:**
1. 本人/CSRF/TTLを検証した初回pendingの`owner/browserId/mode/state/verifier/csrf/expiresAt/redirectUri`を`Object.freeze`でスナップショット化。
2. 認可URLのS256/redirect/client IDは初回スナップショットで検証。
3. `prepare(request, expectedPending)`のサーバー専用引数を追加。Workerへ送る**前**に、2回目に読んだ信頼済みpendingの同じ8フィールドが初回と全て一致しなければ**拒否**。呼出側が省略する既存dummyルートの動作は変更しない。
4. `tests/site-v10-live-candidate.test.mjs`で、URLビルダー実行中にstate・verifier・browserId・CSRF・mode・redirectUriが変更されても、Worker`/prepare`への送信数0、D1登録数0、token交換0となることを検証。

**結果:** [Callback Relay CI 40152450510](https://github.com/EliteMay/pc-agent/actions/runs/40152450510)で**93件全件PASS**、[Gateway CI 40152450508](https://github.com/EliteMay/pc-agent/actions/runs/40152450508)もPASS（開発ブランチ／オフラインのみ）。これで認可URLと署名付きRelay登録の同一pending境界をテストできたが、**保存版10の実本体へはまだ組み込んでいない**。実Siteの並行ブラウザ挙動・Cookie認証・PR #47の実JWT認可は未実測。Web公開・OAuth登録・Secrets・家PCは無変更。
