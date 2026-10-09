# PC Agent OAuth画面のsite-minからの移行

## 完了した作業

- PC AgentのOAuthログイン画面と同意・拒否画面のソースを `pc-agent/web/oauth/` に移行（[pc-agent PR #38](https://github.com/EliteMay/pc-agent/pull/38)）。
- GitHub Pagesで公開し、実際のHTMLをHTTPで取得して検証（[Actions](https://github.com/EliteMay/pc-agent/actions/runs/37893310717)）。
- 旧 `site-min/oauth/login/` / `oauth/consent/` のSupabase認証処理を削除し、同じOrigin `https://elitemay.github.io` 内の固定URLへの互換転送に置換（[site-min PR #2](https://github.com/EliteMay/site-min/pull/2)）。
- 互換ページは `authorization_id` 等のURLクエリとfragmentを保持。静的テストは成功し、旧URLのブラウザ遷移が新URLに到達することを外部取得で確認。
- Health Support本体のHTML/CSS/JSは不変更（`site-min/index.html` のblob SHA不変）。

## 現在のURL

| 目的 | 正本URL | 旧URLの扱い |
| --- | --- | --- |
| ログイン | `https://elitemay.github.io/pc-agent/oauth/login/` | `/site-min/oauth/login/` は転送のみ |
| 同意/拒否 | `https://elitemay.github.io/pc-agent/oauth/consent/` | `/site-min/oauth/consent/` は転送のみ |

旧URLはGitHub Pagesが返す静的HTML内のJavaScriptで転送します（HTTP 3xxではない）。`authorization_id` を保持したURL移動はテスト済みですが、**OAuth認可の実際の許可・拒否操作はまだ未検証**です。

## 残る最終切替（未実施）

1. Supabase Dashboardのプロジェクト `vtnwbgejlaqpnwmlzbjy` で、Authentication → URL Configuration → Site URL、およびAuthentication → OAuth Server → Authorization Pathの**現在値**を確認。今回の作業で設定値は変更していません。
2. Site URLは他の認証リダイレクトにも関わるため、他アプリへの影響を確認できない限り変更しません。OAuthのコールバックRedirect URIも勝手に変更しません。
3. 有効なOAuthクライアントから実際に認可を開始し、旧URLから新URLへの転送、ログイン、許可、拒否を実テスト。これまでの自動テストはこの代替ではありません。
4. 直接新URLを認証先として設定できることが証明できた場合だけ、変更前の設定値を控えた上で切り替え。再度認可と他の認証リダイレクトを検証し、問題時は以前の値へ戻す。
5. Supabase側の旧site-min参照がすべて解消されたことを確かめた後、互換URLの廃止と旧サイトの整理を判断する。Health Supportは保護する。

`site-min` と `pc-agent` は同じ `elitemay.github.io` Origin上なので、URLパス移動自体はWeb StorageのOriginを変えません。ただし既存のOAuthセッションが有効かは実ブラウザで再確認します。

## 境界と未検証

- **本番デプロイ:** PC Agentもsite-minの互換ページも成功。
- **実公開/転送:** 公開HTMLと転送先の到達を検証済み。実際のPC操作は行っていません。
- **OAuth許可・拒否のE2E:** 未検証。ユーザー認証情報を自動化へ入力・収集しません。
- **Supabase設定更新:** 未実施。既存設定を変更したと推測しません。
- **安全性:** Supabase Gateway・端末のローカル承認・Emergency Stop・Game Safetyの仕様は変更していません。

進捗管理: [Issue #39](https://github.com/EliteMay/pc-agent/issues/39)。
