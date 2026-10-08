# Issue #29: Chrome対応Pluginへの移行手順（2026-10-09）

## 原因（確認済み）

現在の個人用Private Plugin「Kaito PC Agent」（内部名 `kaito-pc-agent-oauth-readonly-v2`、v0.3.0）は、プラグインZIP内に `mcp.json` と `.mcp.json` を持ち、既存のSupabase OAuth MCPサーバーのHTTPS URLを直接登録している。

OpenAI公式「[Why is a plugin marked Desktop only?](https://help.openai.com/en/articles/20001256-plugins-in-chatgpt)」および「[Importing and syncing plugin marketplaces](https://help.openai.com/en/articles/20001504-importing-and-syncing-plugin-marketplaces-from-github)」によれば、この形式は接続先がリモートHTTPSでも **Desktop only** として表示される。Chromeでインストール不可。**単にmcp.jsonを削除するとツール自体がなくなるため禁止**。既存アプリへの `.app.json` 参照を足すだけでもラベルは解除されない。

## 使うべき公式経路

[Hosting a plugin with ChatGPT Sites](https://help.openai.com/en/articles/20001547-hosting-a-plugin-with-chatgpt-sites) は全プラン対象。ChatGPT SitesにMCPツールをホストし、Siteの公開で生成されるPluginを使える。ただしSiteの作成/公開は **Work** 等の対応機能から行う。SitesのWeb上の作成にはWorkが必要。現在の通常チャットにはSitesの作成・公開操作ツールが公開されていない。

別経路の「Custom MCP apps / Developer mode」はBusiness/Enterprise/Edu中心であり、個人Plusで自由な書き込みMCPアプリが使えると仮定しない。公式 [Developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt) を確認する。

## 第1目標を変えない最小構成

```text
Chrome版の普通のChatGPT
  → ChatGPT Sitesに紐づく本人所有のPrivate Plugin
  → Site上の狭く定義した認証済みMCPツール
  → 既存のSupabase OAuth Gateway / command queue
  → 家PCの自作ManagerとNode Agent
  → Windowsメモ帳
```

Desktop Commanderは本番経路に含めない。Supabase側のローカル承認・実行ジャーナル・Game Safety・緊急停止も変更しない。

## 実施順（適合性確認が先）

1. ユーザーがChatGPT **Work** で非公開のSiteを作り、Sites用MCPサーバーを追加する。最初のツールは**自宅PCを触らない接続診断**だけ。Siteの公開が実際にWebでインストール可能なPluginを作るか、Chromeで確認する。
2. Site→既存Supabase OAuth Gatewayの認証・代理呼出しが正式な方法で成立するか検証。アクセストークン／service_role keyをSiteの公開ページ、ブラウザJS、リポジトリへ埋めない。OAuthを回避してGatewayのservice roleへ直接アクセスする設計は不採用。
3. 認証済み `ping` が Chrome → Site Plugin → Supabase Gateway → Agent → Chrome に実際に戻ることを確認（コマンドIDなど個人情報を含まない検証ログを保存）。
4. `capture_notepad` を追加し、ユーザーがPC Managerで**毎回明示承認**して、無害なテスト用メモ帳のJPEG画像が普通のChatGPTに表示されるか確認。
5. 最後に `notepad_gui` の対象限定 `open/click/type/scroll/save` を追加。操作ごとの物理承認とゲーム検知を維持し、画面＋保存したテキストの読み直しを行う。
6. Desktop Commanderを完全停止して上記すべてを再試験し、Issue #29の原本の4完成条件を確認した時のみクローズ。

**SiteでOAuth安全性、利用可能なMCP操作、画像の返却が満たせない場合は、その時点で止める。Pluginだけ作って「Chrome対応完成」と宣言しない。**

## Workに貼る最初の指示（まずは安全な最小検証）

> ChatGPT Sitesで自分専用の非公開サイト「Kaito PC Agent Web Bridge」を作成してください。目的はChrome版の普通のChatGPTで使えるPrivate Pluginを作ることです。まずSite内のMCPサーバーに、PCを操作せず固定JSONを返す「gateway_probe」のみを作り、Siteを公開して生成されるPluginがChrome版ChatGPTにインストール可能かを検証してください。既存のGitHubリポジトリ EliteMay/pc-agent と Issue #29 を参照してください。今はSupabaseの鍵・個人トークンを入力、公開、保存しないでください。家PCのクリックや入力機能も追加しないでください。ChromeからのPluginインストールとgateway_probe成功が証明できたら、既存のSupabase OAuth Gateway（kaito-pc-agent-oauth-readonly）へ正式に認証して接続する方法を確認してください。方法が不明なら作業を停止して理由を報告してください。Desktop Commanderを本番依存にしないでください。

## 現時点のステータス

- Site未作成、Web Plugin未作成
- 現行のデスクトップ限定Plugin v0.3.0は**変更していない**
- Supabase側と家PCには今回変更なし
- Chrome向けインストール / 接続テスト未実施
- Issue #29の4つの完成条件は未達
