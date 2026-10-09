# PC Agent OAuth画面のsite-minからの移行

## 目的と現在の境界

旧 `EliteMay/site-min/oauth/login/` と `oauth/consent/` の静的画面を、本来のOwnerである `EliteMay/pc-agent/web/oauth/` へ移す。旧サイトのHealth Support（`index.html`・`kcal.js`・`れんじ.css`）は変更しない。

- **移すもの:** Supabase認証のログイン画面とOAuth同意画面（公開可能なpublishable keyのみ）。
- **移さないもの:** service_roleやsecret、Edge Functions、認可ルール、PCのローカル承認・緊急停止、Game Safety。
- **公開:** `.github/workflows/oauth-pages.yml` が `web/` だけをGitHub Pagesへデプロイする。GitHub PagesのSettingsでSourceにGitHub Actionsが必要な場合がある。
- **正本:** PC Agent OAuthフロントエンドは `pc-agent/web/oauth/`。旧site-minは切替が確認できるまで旧動作を保持する。

## 新しいURL

- Login: `https://elitemay.github.io/pc-agent/oauth/login/`
- Consent: `https://elitemay.github.io/pc-agent/oauth/consent/`

これらは**予定URL**であり、実際のPagesデプロイとHTTP応答が確認できるまでは公開済みとしない。

## 切替の安全な順序

1. PC AgentのPRで `node --test tests/oauth-pages.test.mjs` を確認し、mainに反映する。
2. GitHub Repository Settings → Pages → Build and deployment → Sourceを `GitHub Actions` にする（未設定の場合）。`OAuth Pages` workflowが成功し、上記2 URLを**直接開いて**HTMLが返ることを確認する。
3. Supabase Dashboardで対象プロジェクト（`vtnwbgejlaqpnwmlzbjy`）の Authentication → URL Configuration → **Site URL** と Authentication → OAuth Server → **Authorization Path** の**現状を確認**する。OAuth UIの実効URLはSite URL + Authorization Pathで構成される。現在値と他の利用者・サービスへの依存を確認せずに変更しない。
4. 他アプリへ影響しないことを確認できた場合に限り、Site URLを `https://elitemay.github.io/pc-agent`、Authorization Pathを `/oauth/consent/` として設定する（既存値が異なれば同等の公開ルートとなるように整合させる）。**OAuthクライアントのコールバックRedirect URIは別設定**なので、無条件に変更しない。
5. 新規OAuthフローで新Consent → 新Login → Consentに戻り、**拒否**と**許可**の両方を検証する。GitHub Pagesの両パスは通常同じOrigin（`https://elitemay.github.io`）なのでURL移設だけでWeb StorageのOriginは変わらない。ただし既存セッションの有無・有効性は実ブラウザで確認し、必要なら再ログインする。PC操作を実行する必要はなく、同意フローのみ検証する。
6. 実フロー成功とSupabaseの旧site-min参照がなくなったことを確認した後に、旧`site-min/oauth/`を削除または互換案内画面へ置き換える。**検証前は旧画面を変更しない**。site-minのHealth Supportには触れない。

## ロールバック

切替後にOAuthが動かなくなった場合、Supabase DashboardのSite URL / Authorization Pathを**変更前に控えた実際の値**へ戻し、旧site-minの画面が動作することを確認する。旧画面を残している間はコード移行による障害から戻せる。機密情報・認証トークンをIssuesや公開ログに記録しない。

## 検証状態

- コード移設と静的テスト: PR/Actionsで確認。
- 新GitHub Pages URLのHTTP疎通: 公開後に実確認。
- Supabase Auth設定の切替: Dashboardで既存値と影響確認が必要。
- 実OAuth認証・拒否/許可: 外部クライアントによる実テストが必要。

後半2つが完了するまで「完全移行済み」とは記載しない。
