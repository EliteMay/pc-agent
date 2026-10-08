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


## 2026-10-09 実証結果：ChatGPT Sites固定診断

- [x] ユーザーが ChatGPT Work で [Private Site](https://kaito-pc-agent-web-bridge.kaito2526.chatgpt.site/) を作成し、Chrome版の本人用Pluginから `gateway_probe` の呼び出しに成功。
- [x] **この通常のChatGPTチャットからも**実際の `mcp__Kaito_PC_Agent_Web_Bridge__gateway_probe` を実行し、次の固定値を確認した（正常な固定診断に過ぎない）：
  ```json
  {"success":true,"bridge":"Kaito PC Agent Web Bridge","version":"0.1.0","mode":"fixed-diagnostic","transport":"chatgpt-sites-mcp","pc_connected":false,"supabase_connected":false,"approvals_bypassed":false}
  ```
- [x] Plugin Creatorの作成ガイド・Sites MCP資料で、Siteの認証・ツール実装は **Sites専用の利用可能なskillを使う**必要があり、欠如時は別ホストでの代替や接続済み宣言をしないことを確認。
- [ ] Site専用 `sites-mcp` スキルおよびSiteの下流Plugin許可リスト（`allowed`）は**このセッションに公開されていない**。`allowed` の検証なしに別のPluginをSiteへ接続したり、直接SupabaseへOAuthなしでプロキシしたりしない。
- [ ] 既存のSupabase OAuth Gatewayとの実際の接続・認証・`ping`は未確認。個別のOAuth同意操作や毎回のWindows Manager承認を引き続き必須とする。
- [ ] ユーザーがSiteのWork作業中に保存した `chrome-plugin-verification.md` はこの時点でGitHub `EliteMay/pc-agent/main` 上に**存在を確認できなかった**。本セクションをGitHub側の検証要約として追記した。Site内部ファイルが紐づいている可能性は残る。
- [ ] Issue #29本来の4項目の完成条件は未達、家PCにはまだ接続していない。**診断成功と実操作成功を混同しないこと。**

**次の進め方：** SitesのWorkセッションに戻り、同セッションの `sites-mcp` / `SKILL.md` にある下流連携 `allowed` 判定を実際に確認する。対応するOAuthアプリ・下流プラグインが正式に `allowed` であることが確かめられる場合に限り、Siteからの正規OAuth認証を安全に試す。判定を証明できない場合はそこで止め、実装や認証情報の注入をしない。


## 2026-10-09 正式適格性照会の未提供を確認

ChatGPT Workで検証し、[保存ログ](https://github.com/EliteMay/web-project-data/blob/main/conversations/2026/10/conv-20261009-pc-agent-web-bridge/interactions/2026-10-08/int-20261008T163904Z-allowed-gate-check.json) を読み直して内容を照合した。

- Site: active、本人所有、`access_mode=custom`、許可ユーザー1、外部閲覧者0。Siteの`hosting.json`には固定診断用MCPがあり、下流Pluginやconnectorの宣言は**ない**。
- Sites building skill 0.1.75 `references/plugin-tools.md` が求める **`sites_list_plugin_eligibility`** は当該Workセッションの利用可能ツール一覧に存在せず、別名の正式照会機能も提供されなかった。今回の通常チャット側からも同名機能は利用不能。
- そのため `allowed` でも `denied` でもなく **未判定**。プラン制限、管理者拒否、既存Plugin自体の不適格性は**未確認**である。所有、Pluginインストール、通常の権限、Supabase OAuth実装、HTTPS URL、Site内からの直接HTTP呼出しは`allowed`の代替にしない。
- Supabase OAuth Gateway: ACTIVE デプロイv14、ソースで`withOAuthProtectedResource`、ユーザー認証、許可ユーザー照合を確認。Siteからの実OAuth同意・認証済み診断の成功は未確認。
- [Chrome固定診断結果](https://github.com/EliteMay/web-project-data/blob/main/research/studies/pc-agent/chrome-plugin-verification.md)は **web-project-data** に存在する。以前「pc-agent/mainに見つからない」と記録したのはGitHub保存先が別であったためで、Site内部にしかないと推測する必要はない。

### 今後の再開トリガー

1. OpenAI Help Centerサポートに「このSiteで`sites_list_plugin_eligibility`が提供されないのは正常か、利用可能にする正式な方法があるか」を照会する。**サポートが機能を有効化できると決めつけない**。
2. **正式な**照会機能が実際に提供された場合だけ、対象Siteの実`project_id`で既存Gateway Pluginが`allowed`かどうか、canonical ID・connector所属・利用可能なnative actionsを照合する。
3. `allowed`と必要な診断操作が確認されるまで、Siteの下流Plugin接続、環境変数・権限変更、認証情報の注入、PCコマンドは**実施しない**。繰り返し同じWork照会を依頼するだけのループは避ける。
4. 条件を満たした場合は本人が通常OAuth同意し、まずPC非接触のGateway診断を試す。未認証・拒否・失効・他ユーザー拒否を検証してからPC `ping`に進む。

参照: [OpenAIサポートへの問い合わせ](https://help.openai.com/en/articles/6614161-how-can-i-contact-support)。
