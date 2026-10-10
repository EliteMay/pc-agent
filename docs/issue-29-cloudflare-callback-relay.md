# Issue #29: OAuth callback relay on owner-managed Cloudflare Worker（設計案・未実装）
作成: 2026-10-11。**この文書は設計のみ。本番環境、OAuth App、Sites、Windowsには変更を加えない。**

## 判断理由
- 現状: ChatGPT Sites保存版2のAuth Code + PKCE S256実装、20テスト・型チェック・lint・buildはパス。Secrets 4項目登録済み。しかしSite内 /oauth/callback?code=...&state=... がSites管理Worker/dispatchログに残らない保証が得られないため、公開を停止。
- Supabase OAuth Server公式が記述する方式は authorization_code+PKCE と refresh_token。form_post response_mode / device grant が当該実装で使える証拠は得られていない。未検証方式を勝手に採用しない。
- 代替のemail OTPは、通常JWTで既存Gatewayの withSupabase({auth:"user"}) と本人UUID照合が動く可能性があるが、現在の組織はSupabase Free、対象の「osu-hub」プロジェクトは2026-08-31作成。2026-06-03以降の新規Free+標準SMTPでメールテンプレート変更が不可という公式制限がある。既定テンプレートはMagic Linkで、6桁OTP方式には {{ .Token }} のテンプレートが必要。外部SMTPや既存プロジェクト共通設定の変更を勝手に行わない。**優先案から外す**。
- Cloudflare Workers Freeは本人利用規模なら0円枠（100,000 requests/day）があり、owner-managed Workerの公式script settings APIに observability.redact_query_string、logs.invocation_logs / logs.enabled がある。ただし**設定可能であることと、Cloudflare全レイヤーでログ非保持が保証されることは別**。本番OAuth前に実効値・動作・関連ログを検証。

## 目標構成（旧OAuth・既存Gateway・同意・ローカル承認は維持）
```text
ChatGPT Chrome → 本人限定 Site Plugin
    → Sites本人セッション → /oauth/start
    → Supabase OAuth authorize (PKCE S256, code/state)
    → owner-managed Cloudflare Worker GET /oauth/callback?code=...&state=...
       [このURLをSitesには一切送らない。Worker URLログを事前に保護]
    → Worker は短時間・一回限りの pending code/state を暗号化/アクセス制限つきで保管
    → browser 303 https://kaito-pc-agent-web-bridge.kaito2526.chatgpt.site/connect/complete
       [URL queryは空。コード/state/トークンを付与しない]
    → Sites本人ログイン済みサーバーが state を自セッションから復元
    → Sites server POST https://<worker-domain>/claim (認証済み固定リクエスト、bodyにstate)
    ← Worker HTTPS response bodyでcode/stateを一回限り引き渡す
    → Sitesで本人state照合→PKCE verifier + Workerのredirect_uriでSupabase token交換
    → Sites D1にAES-GCM暗号化 access/refresh token
    → 認証済み既存Supabase MCP Gatewayの tools/call gateway_probe だけ実行
```

## 正式着手前の技術ゲート
1. Cloudflareアカウントの新規作成・料金確認は本人承認。Worker/D1の無料枠を超える設計禁止。自宅Windowsは不要。
2. まず**認可コードなしの無害なダミー**だけでWorkerを検証し、owner-controlled Workerの設定 GET API 実効値と、アカウントで閲覧可能な invocation/logs/traces の範囲を確認。ログ設定は `redact_query_string=true` かつ invocation logs・trace・exportの無効化などの対応候補を比較して採用。**ログ0件だけでは非保持証明にならない**。CF platform・CDNログ等の見えない範囲は未確認と明記し、許容水準を本人と確認。
3. Worker側 callback の正確なURLが確定した後にだけ、本人が Supabase OAuth App の登録済みredirect URIへ追加。既存Site callbackは不用意に消さない。redirect_uriはauthorizeとtoken交換で一致。
4. Workerの受信コードをローカルログ・throw・エラー・レスポンスに表示しない。レスポンスは `Referrer-Policy: no-referrer`, `Cache-Control: no-store`。任意外部URLへのopen redirectを禁止。
5. Sites→Worker `/claim` はサービス認証つき POST body のみ。予測不能なstate、所有者セッション紐付け、短いTTL、**原子的な一回限り消費**、replay拒否、レート制限。署名用シークレットはSites Hosted Secrets/Cloudflare Worker secretsへ双方の公式UIでのみ投入。コード・アクセストークンはquery、browser JS、cookie、MCP tool response、GitHubに出さない。CloudflareのD1/DOを使う場合には保存時暗号化/自動TTL消去/失効確認も必要。
6. Sitesへサーバー間のinbound POSTを飛ばす構成は採用しない。Sitesの本人限定認証が機械間リクエストを拒否し得るため、**SitesがWorkerをpullする**設計でホスト認証を維持。
7. Cloudflare Workerに OAuth client_secret、Supabase service_role、家PC鍵は持たせない。Workerは短命のコード預かりだけ。Siteのowner identityとSupabaseのallowed user UUIDは別々に検証。
8. 20既存mock testsを維持し、Cloudflare callback/claimのstate replay、不正署名、期限切れ、二重消費、URL/log漏洩、owner mismatch、token交換失敗を追加。正規ログイン同意が必要な時点で本人の操作を待つ。
9. 既存公開Siteは固定 gateway_probe のまま維持。実Supabase gateway_probeはサイト接続完成まで未達、家PCの ping / capture / click / type / saveは依然禁止。Desktop Commander本番依存ゼロ・Windowsローカル承認必須。

## 中断条件と選択肢
- Cloudflare FreeまたはWorker Script Settingsにログ保護を設定・検証できない、署名済みPOST claimに失敗、コストが必要、または残るプラットフォームログを受容できない場合は**本番認証コードを発行せず中断**。勝手にOTP・service_role・匿名Gatewayへ格下げしない。
- 本人の明示同意なしにSupabaseメールテンプレート、SMTP、既存OAuthクライアント、公開共有権限は変更しない。

## 公式根拠
- https://supabase.com/docs/guides/auth/oauth-server/oauth-flows
- https://supabase.com/docs/guides/auth/auth-email-passwordless
- https://supabase.com/changelog/46599-changes-to-email-template-customisation-on-free-tier
- https://developers.cloudflare.com/workers/wrangler/configuration/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/settings/methods/get/
- https://www.cloudflare.com/plans/developer-platform/
- [Sites保存版2ログ停止の証拠](https://github.com/EliteMay/web-project-data/blob/main/conversations/2026/10/conv-20261009-pc-agent-web-bridge/interactions/2026-10-09/int-20261009T105430Z-sites-redeploy-safety-gate.json)
