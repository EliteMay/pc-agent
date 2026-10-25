# Issue #29 — Sites保存版10と実OAuth Relayを結線するための正式Readback

## この指示で許可する操作
**読み取り専用。** ChatGPT WorkのSites正式管理機能だけを使い、既存の本人限定Site
`kaito-pc-agent-web-bridge` の **公開中保存版10** と、現在の保存版ソースを比較する。
GitHubの参照コードは PR #42、Gatewayの認可案はDraft PR #47。

**禁止:** SiteのSave/Deploy、OAuth・Relay ON、Secret入力/変更/読み戻し、
Cloudflare Worker/D1/Supabase/Auth登録/redirect変更、PCコマンド、
新たなWebサイト/Plugin/サービス作成、Cloud Browser経由の権限回避。
既存Siteの表示/Sourceを超える実OAuthフローを起動しない。

## 管理画面で実際に取得すること（秘密値を出さない）
1. 正式なSites Native管理から、project slugと **公開保存版10** のバージョンID、source commit、deployment ID、環境revision、本人限定共有範囲を取得。
2. 保存版10の **サーバー側ソース** のファイル一覧とsource commitを取得。下記の該当部分を確認し、**ファイル名・行範囲と yes/no/unknown** で返す。Sourceに機密文字列があっても出力しない。
3. `GET /connect/complete` が表示専用で、D1 pending consume、Worker /claim、OAuth token exchange、その他state-changing操作を行わないか。
4. `POST /connect/complete` がCookie/本人owner、欠落拒否の固定Origin、pending.csrfと `x-oauth-csrf` 厳密比較後だけ一回消費し、署名済みWorker `/claim` を呼ぶか。権限判断にBrowser入力やHTTP由来の偽装identity headerを採用していないか。
5. `/oauth/start` の認可先、pending.redirectUri、Supabase authorize呼出しとtoken exchangeで使用する **redirect_uriが同一** か。現実のWorker固定`/oauth/callback`と一致するか。不一致なら **STOP** と報告し、登録を自動修正しない。
6. 既存Server-only Supabase confidential-client + PKCE交換処理が利用できるか。`code_verifier`は本人ブラウザーpending内で結合されているか。Client secret、認可コード、access/refresh tokenの**値は出力しない**。
7. 既存の`RELAY_MODE`/`RELAY_LIVE_ENABLED`等のHosted環境設定が実際にどの段階までOFFか、名前と安全なbooleanだけ確認。Masked Secretを展開しようとしない。新PR #42のSourceはWorkerで`RELAY_MODE=live`と`RELAY_LIVE_ENABLED=true`、Sites adapterで`mode='live'`と`liveEnabled=true`を要求する。
8. 現行MCPの`gateway_probe`が、OAuth/Relay OFFでも今と同じ固定診断契約を維持する構造か。正式なNativeから公開画面表示とコード対応を確認する。

## 参照コード（GitHubへは変更しない）
- `gateway/cloudflare-callback-relay/src/worker.mjs`
- `gateway/cloudflare-callback-relay/src/sites-client.mjs`
- `gateway/cloudflare-callback-relay/src/protocol.mjs`
- `gateway/cloudflare-callback-relay/README.md`
- `docs/issue-29-sites-release-gate.md`
- `docs/issue-29-oauth-client-scope.md` (PR #47)

## 期待する結果
各項目を **verified / contradicted / unavailable** に分け、本人限定Sourceのファイル名・行範囲と固定のバージョン識別だけ報告。
Source未取得なら `unavailable` とし、GitHub参照Adapterと現Siteを同一視しない。

最後に **本番変更の無い最小のSite結線案** と必要な正式承認を具体的にまとめる。
今回のreadbackだけで完成・OAuth接続成功・PC操作成功とは宣言しない。

## 現在の制約と代替経路
通常チャットのPlugin Creatorが読めるのはSite生成Pluginの`.app.json`/
`.codex-plugin/plugin.json`等で、Hosted Site sourceではない。会話内Browserは
chatgpt.comへのページ観測がホストポリシーで拒否され、回避は禁止。
LibraryのSiteカードは公開ページ説明とversion metadataでありSource本体ではない。

以前の直結 `kaito-pc-agent-oauth-readonly-v2` v0.3.0 は既存の
Supabase OAuth Gatewayを直接参照するが、**Desktop only** の旧Plugin形式。
Chrome版の第1目標の代替として完成扱いしない。
