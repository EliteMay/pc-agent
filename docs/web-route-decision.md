# Web経路（Chromeを含む通常ChatGPT）で `ping` を通す最小の方法 — 決定（2026-10-22）

**範囲:** 調査と決定のみ。Secret登録、Sites／Cloudflare／Supabase の変更、GUI操作は未実施で、それぞれ別承認。ChatGPT・Work・Sitesの内部には Claude は到達できず、そこの事実は「報告」として扱う。

## 1. 事実・報告・未確認

**Claudeが実測（読み取りのみ）**
- 本番Gateway（`kaito-pc-agent-oauth-readonly`、v10）は認証なしだと `401 MISSING_CREDENTIALS`、「受け付ける認証方式は `user`（Supabase ユーザーJWT）」。`WWW-Authenticate` は `resource_metadata` を指す。メタデータは認可サーバー `…/auth/v1` を宣言。
- そのSupabase認可サーバーは **動的クライアント登録（`registration_endpoint`）を公開**し、PKCE `S256`、トークン認証 `none`／`client_secret_*`、`authorization_code`／`refresh_token` に対応。
- Siteの外向きHTTPSはSites公式資料に明記。Sitesの「アプリ接続」は、公式資料上は**ワークスペース内のSiteで訪問者の接続を使いページ読み込み時にデータを読む**機能で、Siteの**サーバー側コードが既存Gatewayを自分の権限で呼ぶ方法の記載はない**。
- Cloudflare Workerの実装（`gateway/cloudflare-callback-relay`）は**ダミー専用**: `RELAY_MODE !== 'dummy'` で `setup_required`、callbackは `dummy-code-…` 形式のみ受理。実OAuthコードを通すにはWorkerのコード変更とデプロイが要る（`oauthCode` 検証関数は未配線）。
- 公式ヘルプ／開発者資料の検索結果: ChatGPTの**開発者モード（Developer mode）のカスタムMCPアプリ**はWebのみ、OAuth（DCR／CIMD）対応。ただしプラン条件は資料間で食い違い（英語ヘルプ: 書き込み対応の完全なMCPは Business／Enterprise／Edu のベータ。フランス語版FAQ: Pro は read／fetch 権限で接続可。Plus の記載は確認できず）。

**ChatGPT側の実測（報告）**
- 自作Sites Plugin `gateway_probe`（固定）は成功、`pc_connected:false`・`supabase_connected:false`。
- `supabase_gateway_probe` は失敗（認証済みGateway診断を確認できず）。
- 既存Private Plugin `kaito-pc-agent-oauth-readonly-v2` v0.3.0 は所有・構成済みで、Supabase OAuth Gatewayを直接参照。ただし現在の通常ChatGPTに `ping`・`capture_notepad`・`notepad_gui` は**公開されていない**。
- Gateway v10は本番デプロイ済み。Agent v0.11.6はハートビート送信済み。

**未確認**
- `supabase_gateway_probe` を定義しているのは何か（Site保存版7？別のコネクタ？）。リポジトリのどのブランチにも `supabase_gateway_probe` という名前は存在しない。
- 本人のChatGPTプランで開発者モードが使えるか、読み取り専用に限られるか。
- Siteサーバーから既存Pluginを呼ぶ公式機能が個人アカウントで使えるか（`sites_list_plugin_eligibility` が提供されず未判定）。
- 保存版8のソース（GET／POSTを含む8項目）。

## 2. `supabase_gateway_probe` 失敗の切り分け
**最有力仮説（コードと実測による）:** 設計どおりの失敗。Gatewayは**Supabaseユーザーのトークンだけ**を受け付け、Sites保存版7（本番）／8（未公開）には**トークンを得る手段がない**（Relay OFF、実OAuthなし、Relay署名Secret未登録）。認証なしの呼び出しは必ず 401 になる。

Workの読み取りで次を確認すれば確定できる（秘密値は記録しない）:
1. そのツールの定義元（Site保存版7のソースか、別のアプリか）と、入力・出力スキーマ。
2. 実行時に外向きリクエストが**送られたか**（送られた場合は宛先と応答コード）。`401`／`MISSING_CREDENTIALS` なら仮説どおり。送られていなければ、ツール自体が固定値を返す実装のはず。
3. Siteの現在の環境revisionとDeployment ID（保存版7＝`appgdep_6ad77b37…`）、Hosted Secrets の**名前だけ**（OAuth用4件のみのはず）。
→ 認証状態ではなく「トークンが存在しない」ことが原因なら、Siteを直しても解決しない（認証経路の追加が必要＝§3）。

## 3. Web経路で `ping` を通す選択肢（最小変更の順）

| # | 経路 | 変更 | 本人操作／承認 | 状態 |
| --- | --- | --- | --- | --- |
| **0** | **ChatGPTの開発者モードで、既存Gatewayを直接カスタムMCPアプリとして追加** | **コード変更なし**（Sites・Cloudflare・Supabase不変） | 設定画面で開発者モードを確認→アプリ作成→Supabaseの同意（本人のみ）。Secretなし（DCR、公開クライアント） | プラン条件が未確認。通れば `ping` と `capture_notepad`（`readOnlyHint:true`）が最短で使える。書き込み系（`notepad_gui` は破壊的ヒント）はプランによりブロックされうる |
| C | Siteが署名付き要求を送る**専用の狭い入口**（Supabase内に関数を追加）を作る。Sitesの本人認証が根拠 | 新しいEdge Function、Site側ツール、共通秘密1件 | 共通秘密を**本人が**Sitesの画面とSupabase側に直接入力、関数デプロイ（別承認）。認証方式の変更を明示承認 | 未実装・未検証。OAuth不要・Cloudflare不要。長期共有秘密という別のリスク |
| A | 現計画（Site内OAuth＋Cloudflare中継） | Workerの実OAuth対応コード＋デプロイ、Siteの実OAuth、SupabaseのOAuthアプリ設定、トークン保管・更新 | Relay署名鍵、Worker・Siteのデプロイ、OAuth同意、複数の別承認 | 最大。ダミー通信すら未実施 |
| E | Siteの「アプリ接続」で既存Pluginを呼ぶ | — | — | サーバー側呼び出しは公式資料に記載なし。適格性は未判定。**現時点では選ばない** |

**決定:** まず経路0を試す（一番小さく、既存の認証済みGatewayをそのまま再利用し、変更が要らない）。経路0が使えない（プラン条件）場合に限り、経路Cを設計・承認の対象にする。経路Aは最後。経路0が成功しても、Issue #29の「自作Plugin経由」の定義（開発者モードのアプリを自作Pluginとみなすか）は本人の判断。

## 4. 経路0 の試験手順（本人が実施。Secretなし、PC操作なし）
1. ChatGPT（Web）→ 設定 → アプリ（Apps）→ 詳細設定（Advanced settings）に**開発者モード**の項目があるか確認。あれば有効化の可否（プラン／管理者条件の表示）をそのまま報告する。
2. 使える場合のみ、「アプリを作成（Create app）」で次を入力: MCPサーバーURL `https://vtnwbgejlaqpnwmlzbjy.supabase.co/functions/v1/kaito-pc-agent-oauth-readonly`、認証はOAuth（動的登録を選べる場合は動的登録）。名前は任意。
3. Supabaseの同意画面は**本人が**承認する（ログインに使うのは自分のアカウント）。
4. 新しい会話でそのアプリを選び、`ping` を実行。その後 `capture_notepad`（Managerでローカル承認が必要。60秒以内）。`notepad_gui` はブロックされるか確認するだけでよい。

**失敗しうる点（先に把握）:**
- プラン条件で開発者モード／カスタムMCPが使えない → 経路Cへ。
- クライアントがストリーミング用の `GET` を送り、Gatewayが `200 JSON`（`service:"pc-agent-oauth"…`）を返すため接続検証で弾かれる可能性。その場合の最小修正は「`GET` に `405` を返す」などの小変更（本番デプロイは別承認、未実施）。デスクトップ限定Pluginが同じGatewayに接続できていた実績はあるが、ChatGPT Web側のクライアントでの実績はない。
- 書き込み系は確認ダイアログが省略される場合がある（公式資料）が、Windows側のローカル承認はこの経路でも省略されない（Agent側で強制）。

## 5. Sites保存版8のGET／POST確認（Workに依頼する範囲）
`docs/work-handoff-sites-v8-get-post.md` の8項目（PR #42 ブランチ）を保存版8 `307a341b…` のソースで確認する。**ただし本決定が経路0または経路Cになる場合、保存版8のRelay統合は当面不要**で、優先度は下がる（経路Aを選ぶ場合のみ必須）。

## 6. 次の最小の1手
**ChatGPT（Web）の設定画面で、開発者モードの有無と、カスタムMCPアプリの作成可否を確認して報告する**（確認だけ。作成・同意は、使えると分かってから）。
