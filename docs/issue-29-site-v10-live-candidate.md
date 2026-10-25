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
| `authorize(request)` | 正式な本人セッション/所有者チェック | メール文字列だけでは高権限を与えない。Site固有の本人ヘッダー真正性は未証明 |
| `verifyIdentityBinding(request)` | **新規の必須サーバー限定アダプター**。本人セッションを独立に検証する | `{owner, principalId, browserId}` を返す。`principalId` / `browserId`は43文字の不透明値で、暗号化pendingの値と両方一致必須。HTTPヘッダー・JSON-RPC・ブラウザから受けた任意IDを検証結果とみなさない。実Sitesの正式な信頼可能識別子取得方法が不明ならOFF維持 |
| `loadPending(request,owner)` | HttpOnly Cookie＋ownerで暗号化pendingを復号してロード | `mode:'live'`、`owner`、**`principalId`**、`browserId`、`state`、`verifier`、`csrf`、`expiresAt`、固定`redirectUri`を返す。既存の保存版11の実スキーマは未確認 |
| `consumePending(pending)` | 既存のDB単回消費 | 並行POSTでも1回だけtrue、値をブラウザに返さない |
| `invalidatePending(pending)` | 既存の失敗時無効化 | 再送で再利用できない |
| `buildExistingAuthorizationUrl(request,pending)` | 既存PKCE S256/機密clientによる認可URL生成 | `state`、`client_id`、`redirect_uri`、実verifierのSHA256 challenge一致を検証後にのみ利用 |
| `exchangeAuthorizationCode(params)` | 既存confidential OAuth clientを使った**サーバー内のコード交換のみ** | この関数内ではトークンをDB/Cookieへ保存しない。code/secretはログ/UIに出さない |
| `supabaseAuth` | Sitesサーバー内の既存Supabase Auth SDKインスタンス（`auth`オブジェクト） | **`supabaseAuth.getClaims(accessToken)`を必ず明示トークン付きで呼ぶ**。本番Supabase Auth projectに設定し、署名を検証済みの`data.claims`だけ後段へ渡す。SDKエラー／null／未構成では拒否。`getClaims()`の無引数呼出・素のJWT decodeは禁止 |
| `storeVerifiedTokens({tokens,ownerUserId,oauthClientId})` | 既存の暗号化トークン保管 | **認証済みclaimsの照合成功後のみ呼ばれる**。対象ownerレコードへの原子的な永続化と、部分失敗時の無効化を正式ソースで実証 |
| `ownerUserId` | 既存のサーバー専用・承認済み所有者UUID | ブラウザ送信値やメールアドレスから導出しない。検証済みJWTの`sub`と完全一致を要求 |
| `oauthClientId` / `key` | 既存のHosted Secret（server-only） | 実値はGitHub/チャット/Browserへ表示しない。Supabase登録との非公開等値照合が必要 |
| `enabled` | 信頼済みサーバー側feature gate | **デフォルトfalse**。ブラウザ/MCP要求でONにできない。Work未公開候補でもOFF保持 |

### ルートの組み込み順

1. 保存版10の既存直接OAuth開始処理のうち、**認証済みの本人ブラウザーにmode='live'のpendingを暗号化保存する部分のみを再利用**する。dummy codeは生成しない。既存の直接OAuth callbackやトークン暗号化処理を破棄しない。
2. 同じ信頼済みrequestで候補`start(POST /oauth/start)`を呼ぶ。候補は既存pendingのowner/CSRF/有効期限と認可URLの`state`、`code_challenge_method=S256`、実verifierのSHA256、`client_id`、固定Worker`redirect_uri`を照合する。その後、署名付きWorker`/prepare`が201を返す場合だけSupabase OAuth認可URLへ303。
3. 認可成功/拒否時にSupabaseからWorker`GET /oauth/callback`へ来るcode/stateは**Workerだけ**で受ける。Workerが暗号化pending保存し、query無し303でSites`GET /connect/complete`に戻る。Sites GETは候補`getComplete()`でホームへ303するだけでconsume/claimしない。ブラウザーに再認可codeを載せない。
4. 既存の本人限定UIからCSRF付き`POST /connect/complete`で候補`postComplete()`を呼ぶ。候補内の既存`createSitesRelayClient`は単回consume、署名付きclaim、サーバー側の`exchangeAuthorizationCode` → `verifyAccessToken` → 所有者UUID・`client_id`照合 → `storeVerifiedTokens`を順番に実行する。成功レスポンスは`{state:'checking', mode:'live', gateway_authenticated:false}`なので、**UIは認証済みと表示せずGatewayの別途確認を要求**する。dummy`checking`表示との互換に注意。
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

## 2026-10-25: メール一致だけでは通さない本人セッションBinding（GitHub source-only）

未公開保存版11のWork報告では、同じ所有者メールなら異なるSiteユーザーIDも`authorize`を通過するモック条件が示された。これは**実Siteのヘッダー偽装成功を示すものではない**。公開仕様に安定した`oai-authenticated-user-id`の提供保証もない。

PR #42のライブ候補のみ、`verifyIdentityBinding(request)`を必須にした。既存の`authorize`に加えて、信頼できるサーバー内セッション検証から得た`owner/principalId/browserId`を、暗号化pendingの同名フィールドと照合する。検証関数が欠ければ`setup_required`で構成拒否、本人が異なれば401、すでに消費済みのpendingは従来どおり409、Relay prepare/claimやToken交換の前に停止する。

`principalId`はSitesが提供する未保証のヘッダー名を指さない。**Siteのサーバー内で検証済みのセッションからしか発行/導出できない識別子**を要求する契約であり、メール・クライアント送信値・任意の自己申告フラグで代用しない。本人固有値を取得・管理できない場合は実OAuthを有効にせず、Sites側の設計を確定してから再実装する。正式保存版11のソース、DBスキーマ、セッション実装が現在の通常チャットで閲覧できないため、**実Siteへの適用・本番動作確認は行っていない**。

追加テストでは（a）検証関数不在、（b）同じメール・偽装ヘッダーと異なる検証済みprincipal、（c）OAuth開始後の認証principal差し替えによるclaim拒否を確認する。live pending作成時にも正しい`principalId`を暗号化保存できること、および実ブラウザ/MCPで同じセッション本人を保証できることは別途確認が必要。Gateway PR #47（JWT実トークン検証）も別のrelease gateとして維持する。

**変更禁止条件:** Sites未公開保存版11、本番保存版10、Sites Secret、Supabase、Cloudflare Worker/D1、OAuthフラグ、家PCは一切変更しない。実認証、ログ/クライアントID照合、実Site本人境界は未検証。条件が未充足ならNO-GOを維持する。

## 2026-10-25: Sites本人確認の公開仕様とSupabase OAuth主体を分離する（設計判断／未実装）

**対象状態:** ユーザーの正式管理機能による報告では、Sites未公開保存版12（コミット `c9f2924499421ad3bfc0b6fcc152a17b9e863a4a`）は97/97件テスト成功・本人検証器未接続でfail-closed。本書から保存版12の実ソース／正式Receiptを独立再取得できていないため、この情報は報告値でありHosted実測ではない。本番は保存版10、OAuth/Relay OFF。PR #42と#47はDraft。

### 調査で分かった事実と、まだ証明していないこと

- [ChatGPT Sites公式 Data and connections](https://learn.chatgpt.com/docs/sites/data-and-connections) が本人情報として記載するサーバー転送ヘッダーは `oai-authenticated-user-email` と任意の `oai-authenticated-user-full-name`。固定・不変の `oai-authenticated-user-id`、任意HTTPクライアントによる同名ヘッダー偽装への明示的防御保証、browser/MCP本人ID相関キーは確認できない。**保証を確認できないことと、偽装が成立した実証は別**。
- [Supabase OAuth Token Security](https://supabase.com/docs/guides/auth/oauth-server/token-security) によれば、OAuth Access Tokenは署名検証可能なJWTであり `sub`（ユーザーUUID）と `client_id`（OAuthクライアント識別子）を含む。[getClaims/getUser公式解説](https://supabase.com/docs/guides/auth/oauth-server/getting-started) は `getSession().user` 単独を認可根拠とせず、検証済みJWTまたはAuthサーバー照会を使うよう求める。
- 読み取り専用のSupabase集計ではOAuth登録3件・同意記録合計2件、稼働中 `kaito-pc-agent-oauth-readonly` はv15。現行Gatewayが発行済みのSites本人JWTを受けている証拠にはならない。SiteのHosted Secretと登録済みconfidential clientのID完全一致は未検証。

### 推奨の認証境界（実装済みと扱わない）

1. **事前ログインと権限行使を分離:** ログイン開始時点でSupabase検証済みユーザーが存在するとは仮定しない。本人検証前のルートを設けるとしても、短命・単回・HttpOnly/SameSite/SecureなブラウザセッションとCSRF/Origin/PKCE/stateを持つOAuth開始処理に限定し、Gateway呼出し・トークン参照・PC操作は一切許可しない。これらを実装する前に保存版12の実コード・旧フロー・保存スキーマを確認する。現在の保存版12はfail-closedを維持する。
2. **OAuth交換後の本人確定:** Site server-only内で既存のSupabase OAuth Code交換を行い、認証サーバー由来の署名検証済みユーザーUUIDが許可されたowner UUIDに一致し、`client_id` が正式に登録・照合されたSiteクライアントIDに一致することを確認する。Issuer、期限、Audience、Client、Session失効方針も検証し、不一致／欠落／検証失敗は認証セッションを確立せずトークンを無効化・安全に破棄する。秘密値・JWT・codeはUI/URL/ログに返さない。
3. **ブラウザー認証とMCPを別扱い:** OAuth後に作ったサーバー署名／暗号化セッションは、それが真正に検証されたブラウザー操作にしか使えない。MCP要求が同じセッション／本人に結び付くことをプラットフォームが保証するまで、browserでのOAuth成功をMCPの権限証明に流用しない。必要なら既存Gatewayの検証済みSupabase Bearerと紐付ける別途の狭い本人Binding方式を評価するが、`owner email`、クライアント送信Cookie/ID、自己申告セッションだけでは紐付けない。
4. **Gatewayで最終権限制御:** PR #47の既存 `withSupabase({auth:"user"})` の検証済みJWT `sub` / `client_id` および既存owner UUID allowlistを全到達可能な権限ルートに適用する。Site OAuth clientは当面 `gateway_probe` / `relay_ping` / `ping` だけ。MCP `tools/list`だけではなく直接 `tools/call` をキュー投入前に拒否。旧Pluginのclient IDを推測で特権付与しない。
5. **明示承認付き段階検証:** 本人セッションの真正性とSite Secret一致が確認された後でも、Worker callback追加、署名鍵共有、残余ログ保護、旧Plugin互換、ロールバック、OAuth実同意は独立したrelease gate。最初は読み取り専用の `gateway_probe` まで。家PCのpingやGUI操作はさらに別途の明示承認と現地Manager承認が必要。

### 重要な設計上の注意

`verifyIdentityBinding` が不透明な `principalId` を返しても、それを**メールヘッダーや自作セッションから自己生成しただけでは本人の証明にならない**。特に、OAuthログイン前に「既に本人検証済みのprincipal」を要求する仕様と「OAuth自体で本人を検証する」仕様を混同するとログインのbootstrapが循環する。保存版12に適用する前に、どの処理がログイン前でどの処理がログイン後か、トークンの格納キーと実MCP呼出しに使う認証根拠を正式ソースで検証すること。

**本変更はGitHub設計メモのみ**。未公開Sitesの書換え、Cloudflare/Supabase/Secret/DB/PCの変更、OAuthの実認証・有効化、JWTを伴う実E2Eは行わない。

**回帰テストの必須観点:** 同メール・別主体、偽装ヘッダー、別Supabase user `sub`、別 `client_id`、期限切れ/改ざんJWT、本人変更途中のpending、別ブラウザCookie、MCPとブラウザのSession非共有、同時callback/二重claim、ログへのcode/token混入、旧Client影響、直接MCP `tools/call`での拒否。外部署名やHostedプロキシ保証をモックだけで「実証」としない。

## 2026-10-25: コード交換後の検証を永続化の必須前提にする（未公開PR #42のみ）

`src/verified-oauth-exchange.mjs`を追加し、`site-v10-live-candidate.mjs`のlive token handoffを3段階（exchange / verify / store）に変更。`exchangeAndStoreExistingOAuth`という従来の一体callbackは受け入れない。トークンがOAuth endpointから返ったことだけを成功条件にせず、

- **正式な外部署名検証:** サーバー専用`verifyAccessToken` callbackがSupabase Auth/JWKS等の正式な手段でaccess token署名、issuer、audience、期限を検証。新しいmoduleはJWTを復号・署名検証するものではなく、**既に検証されたclaimsの一致ポリシーだけ**を持つ。
- **権限Binding:** `sub`が設定済みowner UUID、`client_id`がサーバー側OAuth client ID、`iss`が対象Supabase Auth、`aud=authenticated`、`role=authenticated`であることを要求。期限切れ、未来`iat/nbf`、匿名ユーザー、矛盾する`user_id`は拒否。
- **暗号化保存の後置:** 検証・照合が通るまで `storeVerifiedTokens` を**一切呼ばない**。返却はブラウザに`checking`のみ。Siteの既存暗号化Store/Rollback APIの実装は別途必要。

**テスト:** [PR #42](https://github.com/EliteMay/pc-agent/pull/42)のCallback relay dummy CIは99/99 PASS。追加テストで別ユーザー／別client／issuer不一致／期限切れ等11種類で保存0、検証例外・不正トークン応答で保存0、Store例外で単回consumptionと安全なエラーを確認。ただしこのテストの`verifyAccessToken`は**テスト専用mock**であり実JWT検証の実証ではない。

**互換性注意:** この変更はPR #42の**未公開候補APIを意図的に変更する**もので、Sites保存版12への適用済みを意味しない。Sites本体の既存Token exchange/store関数は実ソースを確認し、暗号化Storeへ書き込むタイミングを分割できなければNO-GOとする。また、保存版12で未接続の`verifyIdentityBinding`は引き続き必須で、OAuth開始前に正式本人を証明できない循環bootstrap問題はこの変更では解消しない。Browser⇔MCP本人一致、Supabase OAuth client secret一致、Worker callback登録/ログ、PR #47の本番反映も未検証。

**本番:** Sites公開保存版10・未公開保存版12・環境revision 5・OAuth/Relay OFF、既存DB/Secrets/Supabase/Cloudflare/家PCは無変更。署名検証callback未実装・未デプロイ。実OAuth同意・PCコマンドは行っていない。

## 2026-10-25: Supabase Auth SDKの実検証APIへ接続する未公開Adapter

追加: `src/supabase-access-token-verifier.mjs`、テスト `tests/supabase-access-token-verifier.test.mjs`。候補 `createSitesV10LiveCandidate` の構成を、任意の `verifyAccessToken` callback ではなく、Site server-onlyから供給する `supabaseAuth` へ変更。内部 `createSupabaseAccessTokenVerifier(supabaseAuth)` は **`auth.getClaims(accessToken)` をトークン引数を明示して呼び**、SDKの検証が成功しない限り401で停止する。既存の `verified-oauth-exchange.mjs` の所有者UUID・`client_id`・issuer・audience・期限チェック、検証完了前の保存禁止は維持する。

- **公式根拠**: [Supabase JS getClaims](https://supabase.com/docs/reference/javascript/auth-getclaims) と [auth-js型宣言](https://app.unpkg.com/%40supabase/auth-js%402.90.1/files/dist/main/GoTrueClient.d.ts)。`getClaims(jwt?)` の明示JWTは署名検証対象のOAuthアクセストークンを指定する。非対称鍵ならJWKS検証、従来の対称鍵ならAuth server照会により検証。JWT文字列の自前デコードだけでは通さない。Siteが使うSDKバージョンは正式ソースから特定・確認する必要がある。
- **fail-closed**: SDKが未設定、`getClaims`欠如、不正トークン、SDK例外、`data.claims`欠落、`error`有りを拒否。SDKのAuthセッションや `getSession().user` へのフォールバック禁止。SDK/トークン内のエラー詳細をブラウザへ返さない。
- **現状テスト**: 本変更のテストはSDKの `getClaims` インターフェースを模擬した**オフラインmock**であり、JWKSや実Supabase Authへのネットワーク通信・署名検証はまだ未実施。Callerから渡されるトークンをSDKへ正確に渡す点、拒否時にToken保存・Relay再請求をしない点を確認するもので、**実Siteで本人検証が成功した証拠ではない**。
- **実Siteへ導入する条件**: 未公開保存版12の正式ソースと現存依存を確認し、その既存Supabaseクライアントが**正しいAuth URLで構成され、Secret/Tokenがserver-only**であること、コード交換と暗号化保管を分離できること、受け取ったOAuth tokenの `client_id` と本人UUIDが期待どおりであることを安全な検証経路で確認する。公式のサイト本人プリンシパル検証機構は別途未解決。Cookie/CSRF/PKCE/並行実行/PR #47の最終権限境界を飛ばさない。

このPRは未公開Source候補のみ。本番Sites保存版10と未公開保存版12、本番Supabase Gateway、Worker、Secrets、DB、PCには手を加えていない。
