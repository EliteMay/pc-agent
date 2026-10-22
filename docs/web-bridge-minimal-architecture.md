# Web Bridge の最小構成（Chromeの通常ChatGPT → Kaito PC Agent Web Bridge → Supabase Gateway → 家PC）

**日付:** 2026-10-22。**範囲:** 構成の決定、移植用の参照実装（ローカルテスト済み）、Workへの確認事項、承認が必要な操作。Sites／Cloudflare／Supabase の変更、Secret登録、デプロイ、PC操作は**一切未実施**。Claude は Sites の保存版（7／8）のソース、ChatGPT・Work の内部状態に到達できないため、そこは「報告」または「未確認」として区別する。

## 1. 到達目標（この段階の限定）
通常ChatGPT（Chrome）から Web Bridge の Plugin ツールを呼び、**本人認証付き**で Supabase Gateway を経由して家PCの `ping` に `pong` が返ること。画面取得・GUI操作はこの段階に含めない。

確認の3段階（Gateway v10 の既存ツール。Gatewayは変更しない）:
1. `gateway_probe` — 本人のSupabaseトークンが有効で、許可ユーザー（`oauth_allowed_user_id`）であることの確認。PCには触れない。
2. `relay_ping` — デバイス登録とハートビート（`lastSeenAt`、`agentVersion`）の確認。PCにコマンドを送らない。
3. `ping` — PC Agent へコマンドを送り `pong` を取得（45秒以内、ローカル承認なしの読み取り専用）。

## 2. 事実
- **Gatewayはユーザーのトークンしか受け付けない**（認証なしは `401 MISSING_CREDENTIALS`、「`user` 認証のみ」。本日実測）。したがって、ダミー認証や固定診断では `ping` に到達できない。**実OAuthが必須**で、ダミーは本番認証の代わりにならない。
- 現在の Web Bridge（保存版7、本番）にはトークンを得る手段がない（Relay OFF、実OAuthなし、Relay署名Secret未登録）。`supabase_gateway_probe` が「認証済み診断を確認できず」となるのは、この設計上の結果と考えられる（Sites側ログは未確認）。
- Supabase の認可サーバーは Authorization Code + PKCE（S256）と refresh_token に対応し、動的クライアント登録も公開している。
- Cloudflare Worker は**ダミー専用**（`RELAY_MODE !== 'dummy'` は拒否、callbackは `dummy-code-…` のみ受理）。実OAuthのcodeを通すにはWorkerのコード変更・デプロイ・Supabase側のredirect登録・署名鍵の共有が別途必要。
- Siteの当初設計（保存版2）は「Site内で直接 Authorization Code + PKCE」で、OAuth用Hosted Secrets 4件を登録済み。停止理由は**ただ1つ**: callbackの `?code=…&state=…` がSitesのログに残る保証がないこと。

## 3. 決定: Site内の直接OAuth（Authorization Code + PKCE S256）を本命とし、Cloudflare中継は第1目標から外す
**理由**
- 必要なのは「本人のSupabaseトークン」だけで、Gateway・Agent・DBは変更不要。追加のEdge Function、新サービスなし。
- 中継を外すと、未解決だった**署名鍵の共有問題、Workerの実OAuth化と再デプロイ、ダミー通信の完走**が不要になり、承認の件数が大幅に減る。
- ログ懸念の実質的な影響は小さい: codeは**一回限り・短命**で、引き換えにはSite内にしかない **PKCE検証子（verifier）**（と、機密クライアントならclient secret）が要る。ログにcodeが残っても、それだけではトークンを得られない。`state` もSiteのセッションに紐づくため単独では使えない。
- 中継は「ログに何も残さない」という**より強い性質**を買う設計だが、その代償（上記の未解決事項）が第1目標の到達を遅らせている。

**これは認証設計の方針転換であり、本人の明示承認が必要**（元の停止理由を受け入れるかどうかの判断）。受け入れない場合は、中継を実OAuth対応にする（Worker変更＋デプロイ＋署名鍵共有＋redirect登録）ことになり、第1目標の到達は大きく遅れる。

## 4. フロー（Site内の直接OAuth）
```text
Chrome ChatGPT ──(Plugin tool)──▶ Web Bridge（Sites、本人限定・Hosted）
  ① tool pc_ping: Siteが本人のトークンを探す
     ・なし／期限切れ → {state:"auth_required"}（ブラウザで開く接続ページのURLのみ。秘密なし）
  ② 本人がブラウザで接続ページ → [POST /oauth/start]（本人認証・Cookie・Origin・CSRF）
     Site: state と PKCE verifier を生成し、本人＋ブラウザに紐づくpendingとしてD1に保存
     → 302 Supabase /auth/v1/oauth/authorize（code_challenge S256、固定redirect_uri）
  ③ 本人がSupabaseで同意（本人のみ）→ GET /oauth/callback?code&state
     Site: 本人のCookieセッション＋pendingを照合 → pendingを一回消費 → codeを即トークン交換
     → アクセス／リフレッシュトークンをAES-GCMでD1へ保存（暗号鍵はHosted Secret）→ 303（query無し）
  ④ tool pc_ping: Siteが保存トークンでGatewayを呼ぶ（gateway_probe → relay_ping → ping）
     Gateway: JWT検証＋許可ユーザー照合 → 既存キュー → 家PC Agent → pong
```
**保つ制御（参照実装でテスト済みのもの）**: PKCEはS256、検証子はURL・応答に出ない／redirect_uriは固定の完全一致／stateは一回限りで本人＋ブラウザに束縛・定数時間比較／`iss` 検証／コールバックの重複・余分なパラメータ・フラグメント拒否／エラー説明の破棄／トークン応答の型・長さ・期限検証と不要フィールドの破棄／Gateway宛先は固定、`redirect: error`、タイムアウト、応答サイズ上限、JSON-RPC id照合／許可ツールは `gateway_probe`・`relay_ping`・`ping` のみ（`capture_notepad`・`notepad_gui`・書き込み系は到達不能）／トークンは結果・エラー・ログに出さない。

**Siteが別途保つもの（Work側。参照実装の範囲外）**: 本人認証（Sitesの信頼済みdispatch identity）、HttpOnly Cookie、`/oauth/start` のCSRF・Origin固定、リフレッシュの単一飛行（二重更新の防止）、トークンの暗号化保管と失効（接続解除）、Plugin応答に秘密を含めないこと。

## 5. 参照実装（`gateway/site-oauth-reference/`）
移植用の純粋関数（Web標準APIのみ）と、ローカルテスト17件（Node 22/24、`npm test`）。ミューテーション確認済み（許可ツール拡大／state検査削除／PKCE方式の変更でテストが失敗する）。`oauth.mjs`（PKCE、authorize URL、callback検証、トークン要求／更新要求、トークン応答検証）、`gateway-client.mjs`（許可リスト付き、トークン非露出）。**Sitesの実コードでも同じ性質が成り立つかは、移植後にWorkでテストすること。**

## 6. 未確認事項と、Workへの確認依頼（読み取りのみ。秘密値は記録しない）
| # | 確認項目 | 目的 |
| --- | --- | --- |
| W1 | 保存版7（本番）と保存版8のソースに、直接の `/oauth/callback`（保存版2系）が残っているか、`/connect/complete` に置き換わっているか | どこまで流用できるか |
| W2 | OAuth用Hosted Secrets 4件の**名前と用途**（client_id／client_secret／暗号鍵／セッション鍵など）。Supabase側のOAuthクライアントが機密か公開か、**登録済みredirect URI**（`…/oauth/callback` を含むか）、要求scope | 新しいSecret登録が要るか |
| W3 | MCPツール呼び出し時にSiteが見る本人の識別子（ChatGPT認証の識別ヘッダーなど）と、トークン行をそれに紐づける方法 | トークンの持ち主の束縛 |
| W4 | `supabase_gateway_probe` の定義元、スキーマ、実行時に外向きリクエストを送るか・応答コード（401想定） | 失敗原因の確定 |
| W5 | 現在の環境revisionとDeployment ID、D1の4表の内容（暗号化トークンを置ける列があるか）、保存版8の追加migrationの有無 | 変更の範囲 |
| W6 | `docs/work-handoff-sites-v8-get-post.md` の8項目（GET／POST、CSRF、Origin） | 保存版8を流用するなら必須 |
| W7 | Siteから `*.supabase.co` へのHTTPS外向き通信が実際に通るか（読み取りの確認方法） | 外向き通信の実測 |

## 7. 承認が必要な操作（まとめ。未実施）
1. **方針の承認**: 中継を第1目標から外し、直接OAuth（ログのcodeはPKCEで保護）を採用する。
2. Supabase側: 既存のOAuthクライアントを使う場合の redirect URI の確認（登録済みなら変更なし）。新規登録・変更は別承認。
3. Site: 直接OAuth＋`pc_ping` を含む新しい保存版のデプロイ（D1スキーマ変更の有無で再評価）。
4. 本人操作: ブラウザでの接続（同意）。ログイン情報の入力は本人のみ。
5. Secretの新規登録（暗号鍵などが無い場合のみ）— 値は本人がUIへ直接入力。

## 8. 範囲外
画面取得・GUI操作（Web経路で `ping` が通った後）、Cloudflare中継の実OAuth化、新しいEdge Function、Desktop Commander（実行基盤として使わない）。
