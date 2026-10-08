# Issue #29 — ChatGPT Sites OAuth Bridge 第1段階（2026-10-09）

## 目的と確定した構成

**唯一の目標：** 個人PlusのChrome版ChatGPTから、本人所有のPrivate Site Pluginを通じ、既存のSupabase OAuth MCP GatewayとWindows Agentに接続し、Desktop Commanderに本番依存せずPC操作を行えるようにする。

今回はその前段である **Sitesの本人ログイン → Supabase Auth OAuth 2.1認可 → Sitesサーバーの保護セッション → 既存Gatewayの `gateway_probe`（PCへ未送信）** だけを対象とする。現行Sitesの固定 `gateway_probe` は成功済みだが **SupabaseやPCへの接続ではない**。

```text
Chrome ChatGPT → Site生成Private Plugin
  → SiteのMCPツール（段階1：接続状態と診断だけ）
  → Siteのサーバー側OAuthクライアント / 安全なセッションストア
  → 既存Supabase Auth OAuth 2.1（別の本人同意）
  → 既存Supabase OAuth MCP Gateway の tools/call gateway_probe
  → 「認証済みGateway診断結果」のみChatGPTへ返却
```

Windows Agent、command queue、Notepad、`ping`、`relay_ping`、`notepad_gui` は**第1段階では呼ばない**。Gateway `gateway_probe` はOAuthに守られたMCP `tools/call` ハンドラー内に既にあるため、認証回避可能な別HTTP診断APIを新設しない。

## サポート・公開ドキュメントから分かったこと

- 個人PlusでもChatGPT Sites自身のサーバー側コードから外部HTTPS APIへ通信する構成は想定されている、とOpenAI AI支援サポートが案内。**実際のOAuthクライアント登録と動作確認は別**。
- Sitesの Sign in with ChatGPT とサーバー受信時の `oai-authenticated-user-email` ヘッダーが利用可能。ホスティングの**信頼された認証コンテキスト**でのみ使用する。利用者のブラウザJSや任意のリクエストヘッダーを信じて所有者判定しない。名前ヘッダーは認可に使用しない。既存Siteの所有者限定公開は維持。
- Sitesはホスト環境変数・シークレット、必要に応じてD1永続DBをサポート。秘匿情報は**Sites > 対象Site > More actions > Settings** で本人が登録し、反映には認可した保存済みSite版の再デプロイが必要。シークレットをプロンプト、GitHub、`.openai/hosting.json`、公開ページ、クライアントJS、ChatGPTのツール応答へ出さない。
- Supabase Auth OAuth 2.1の **authorization_code + PKCE S256** と refresh_token を使う。第三者OAuthクライアント実装を `supabase-js.auth.signInWithOAuth` 等と同一視しない。既存の `withOAuthProtectedResource({authorizationServer: SUPABASE_URL + "/auth/v1"})` と `withSupabase({auth:"user"})` に従い、本人Userのアクセストークンで既存Gatewayにアクセスする。
- Sitesの「connected apps／下流Plugin」を使わないため、その機能の `allowed` 判定はこの独立OAuthクライアント方式に適用しない。ただし**Sitesの実際の機能・権限・安全ブロックは尊重**する。ブロック時に別経路で迂回しない。

## 実装順と安全ゲート

### 0. SiteランタイムとOAuthプロバイダ設定の読み取り調査（変更なし）

1. 既存Site `Kaito PC Agent Web Bridge` のソース、`.openai/hosting.json`、サーバールーティング、D1バインディング有無、ログイン状態、MCPツールを**読み取り**で確認。元の `gateway_probe` を壊さない。
2. 既存Supabase Auth OAuth 2.1 Serverの**公開Discovery**からauthorize/token/issuerの実URLと可能な認証方式を調べる。値を想像でハードコードしない。既存Gateway `gateway/oauth-pc-agent/index.ts` はOAuth-protected MCPで、`gateway_probe` は `tools/call` のnameとして実装済み。
3. Supabase OAuth ServerでこのSiteの**正確なHTTPS callback URL**を認可した専用クライアントとして登録可能か確認。手動Client登録を優先し、誰でも登録可能になるDynamic Client Registrationは便宜のためだけに有効化しない。
4. サーバー実装に**ユーザーごとの安全な永続ストアと暗号化キー**が使用可能であることを検証。不明なら設計・モックテストまでで停止。

### 1. Sites UI とサーバー側OAuthフロー（PC操作なし）

- 画面：「未接続」「Supabaseへ接続」「確認中」「接続済み」「再認証が必要」「切断」の状態を表示。本人の操作だけでOAuthを開始し、第三者サイトへ黙って自動遷移しない。
- `/oauth/start` 等の実名はSiteのルーティング慣習に合わせる。認証済みの**本人セッション**をサーバーで確認し、CSRF対策を備えた明示的なユーザー操作だけで開始する。
- サーバー側で暗号学的にランダムな `state`、`code_verifier` を生成し、`S256` の `code_challenge` を構成。本人セッションと関連付けた`state`、verifier、厳格な有効期限、使い捨てフラグを**サーバー側に保存**する。
- 同意画面は**Supabase Auth側**で表示。Siteの偽同意画面で代替しない。認可コードと `state` はSiteの登録済みの正確なコールバックへ返る。
- callbackは`state`照合とセッション結合・TTL・一回限りの消費を**トークン交換の前**に実施し、PKCE verifierとexact redirect URIを使ってサーバーから交換する。失敗時は何も保存しない。`error=access_denied`等は明示的に拒否状態として終了。
- 認証済みのSupabaseユーザーIDは、Gateway側の`oauth_allowed_user_id`照合に任せる。ChatGPT SitesのメールまたはSite固有IDをSupabaseユーザーIDと同一視しない。Site側のセッションの乗っ取り・取り違えを防ぐため本人コンテキストにトークンを厳格に紐付ける。
- access/refreshトークンは**Siteサーバー側限定**で暗号化して永続保管。AES-GCMなど適切なAEAD、鍵はhosted secret、鍵ID/バージョンを保存、復号・ローテーション・期限管理・同時refresh競合・無効化時の削除を設計。トークンそのものをCookie、URL、localStorage、ログ、MCP応答に入れない。ブラウザセッションcookieを使う場合はHttpOnly/Secure/SameSite等を適切に構成。
- 切断時はSite側token/セッションの参照を削除。Supabase OAuth側のrevokeが提供される場合は実際に失効し、対応していない場合は遠隔失効を実行したと主張しない。ユーザー単位の再接続を扱う。

### 2. 最初のリモート診断

- OAuth完了前は`gateway_probe`以外を含む**全てのSupabase MCP呼び出しを拒否**。接続後、Site内で許可するSupabase MCP呼び出しは`tools/call`の**name=`gateway_probe`、arguments={}の固定1種類だけ**とする。外部から任意のtool名・URL・メソッド・引数・Bearer値を指定させない。
- Siteから既存Supabase GatewayのHTTPS endpointへ、ユーザー本人の`Authorization: Bearer <access_token>`とMCP準拠のJSON-RPCを送る。Supabase接続までの結果は「Site診断」と別の表示項目にする。
- 成功判定：認証済みMCPの応答が`gateway:"supabase-oauth"`、`service:"pc-agent-oauth"`等と一致すること。レスポンスは必要な無害な文字列/真偽値だけへ限定してChatGPTへ返す（例：`gateway_authenticated:true`）。GatewayからのOAuth `401`、権限 `403`、拒否、失効、期限切れ、予期しない`tools/list`やGUI実行結果は診断成功とみなさない。
- `response.ok`は全2xxに対応すること（Supabase 2026-06 OAuth tokenレスポンス200変更あり）。レート制限、タイムアウト、発行先・ホスト名の固定、redirect先の検証、通信ログのtoken/code/verifier伏せ字を実装する。
- 後から`ping`、`capture_notepad`、`notepad_gui`を許す場合は**別PR、別検証**とする。ChatGPTのツールUIの承認に加えて**Windows Managerでの毎回の本人承認**を必ず維持する。

### 3. テスト / 正式完了条件

- 成功：Site本人ログイン → Supabaseで本人OAuth同意 → Site callback交換 → サーバーのみのトークン保存 → Site MCP `gateway_probe` → 実際の既存Supabase Gateway `gateway_probe` 結果。固定JSONを成功の代用品にしない。
- 失敗試験：未ログイン、所有者以外、同意拒否、`state`不一致/使い回し/期限切れ、verifier不一致、callback URL不一致、OAuthトークン失効、refresh再利用、異なるSupabase利用者、401/403、ネットワークタイムアウトで**deny closed**する。
- 模擬テスト：外部APIへの本接続なしでOAuth状態遷移・AES-GCM暗号化/復号・一回限りのstate・本人結合を検証。統合テストのmock successを本番接続成功と呼ばない。
- ログやSite状態ファイルからtoken/access/refresh/client_secret/暗号鍵が漏れていないこと、Siteの共有設定が本人限定のままであることを確認。
- この第1段階の完了はIssue #29の元の4完成条件（実PC ping・スクリーンショット・GUI操作・Desktop Commanderなしの完全往復）を達成したことにはならない。Issueは開いたまま維持。

## Workでの実装用指示（Sites専用ツールが使えるセッションで実行）

> 既存の本人専用Site「Kaito PC Agent Web Bridge」を更新してください。ゴールは第1段階のSites自身のOAuthクライアント実装だけです。GitHub `EliteMay/pc-agent` のこの文書 `docs/issue-29-sites-oauth-stage1.md` を要件として読み、Site固有スキルと実際のSiteソース/バインディングを確認してください。Sitesの connected apps 機能や`sites_list_plugin_eligibility`には依存しません。最初にSupabase Auth OAuth 2.1の公開Discoveryと既存Gateway `gateway_probe` のMCPスキーマを確認し、登録用exact redirect URIと必要なhosted secret名を整理してください。まだ値は一切入力しないでください。次に本人専用「PC Agentに接続」画面、サーバー側Auth Code+S256 PKCE、stateの本人セッションへの結合、使い捨てTTL、暗号化したユーザー別トークン保管、切断/失効、MCP `gateway_probe`の固定許可リストを実装・モックテストしてください。公開前に安全レビュー、設定不足時の拒否挙動を確認。必要なclient登録・秘密値の投入・実OAuth同意が必要な段階は作業を止めて、ユーザーが行う公式UI上の最小操作だけ提示してください。PC操作ツール、既存GatewayやWindows Agentの変更、Desktop Commander本番依存、`service_role`利用、同意省略は禁止。実認証・診断が済むまでSiteに「Supabase接続済み」と表示しないでください。

## 参考（公開ドキュメント）

- [ChatGPT Sites](https://learn.chatgpt.com/docs/sites) — Sign in with ChatGPT、サーバー側identity header、D1、hosted secrets。
- [Supabase OAuth 2.1 Server](https://supabase.com/docs/guides/auth/oauth-server) / [OAuth flows](https://supabase.com/docs/guides/auth/oauth-server/oauth-flows) — OAuth第三者クライアントとPKCE。
- [Supabase MCP authentication](https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication) — metadata discovery、client登録、本人同意、refresh管理。
- [Supabase Changelog](https://supabase.com/changelog) — OAuth token endpoint HTTP 201→200 の変更を反映すること。
- [Issue #29](https://github.com/EliteMay/pc-agent/issues/29)。
