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

## 2026-10-20：Sites保存版2の実装再開（Work実行用・ダミー限定）

### 現在のブロッカー（同じCloudflare監査を繰り返さない）

- 通常チャットから専用Siteプラグイン `gateway_probe({})` を**再実行済み**。応答は `mode: fixed-diagnostic`、`supabase_connected:false`、`pc_connected:false`。公開Siteは未だ固定診断版。
- [Sites保存版2のWork記録](https://github.com/EliteMay/web-project-data/blob/main/conversations/2026/10/conv-20261009-pc-agent-web-bridge/interactions/2026-10-09/int-20261009T105430Z-sites-redeploy-safety-gate.json) により、2026-10-09時点のSource SHA `63f617624ef192bc397e0b875eda5593bc3ac854`、`deployment_id:null`、20/20テスト・型・lint・build成功、Hosted Secrets 4件の**存在だけ**確認。Workを再開したらSite自身のCurrent SourceとDeploymentを新規に読み、古いSHAを現行扱いしない。
- Sites保存版2を停止した理由は、Site側 `/oauth/callback?code=...&state=...` のrequest URLがプラットフォームログに残らない保証がないこと。本人管理Cloudflare Workerへqueryを隔離するdummy-only relayは[PR #42](https://github.com/EliteMay/pc-agent/pull/42)で準備済み。署名付き prepare / claim、ダミーcallback 303、D1一回限り消費はCloudflare実環境で過去に本人が検証。現行稼働版とPRビルド完全一致・全ログ層の非保持は未証明であり、実OAuthは引き続き禁止。
- **この通常チャットにはSites保存版を読む・編集・保存する専用ツールが存在しない**。GitHubのrelayテストが成功してもSiteが更新されたことにはならない。WorkでSiteネイティブの操作が利用できる場合だけ続行。Claude CLIやChatGPT内のClaude連携も未確認であり、第三者に認証情報を送らない。

### Workで実行する次の1タスク（現本番へは非反映）

対象: 所有者本人限定の既存 `Kaito PC Agent Web Bridge` Site。新規Site・新規Cloudflare Worker・別Supabase Projectは作らない。

1. Sites native toolsと該当Siteの書込み可能性を確認し、**保存版2のCurrent Source**、OAuth pending/session D1 schema、owner/HttpOnly session、既存Routes、固定 `gateway_probe` の実装を読み取る。Source SHAと現在のdeployment ID・共有範囲を記録。CLIやCloudflare管理APIでSites内部を勝手に代替しない。
2. [PR #42 `src/sites-client.mjs`](https://github.com/EliteMay/pc-agent/blob/feat/issue-29-cloudflare-relay-dummy/gateway/cloudflare-callback-relay/src/sites-client.mjs) と [protocol](https://github.com/EliteMay/pc-agent/blob/feat/issue-29-cloudflare-relay-dummy/gateway/cloudflare-callback-relay/src/protocol.mjs) を参照し、既存Site保存版2の**サーバー内**に `/oauth/start`（同一Origin POST/CSRF/本人/HttpOnly session/原子的pending）と `/connect/complete`（同一Origin GET、URL query拒否、pending消費後サーバー署名POST `/claim`）を最小変更で統合する。ブラウザJS・MCPの出力にraw state/code/verifier/tokenを渡さない。
3. 初回は**in-process mock relay + fake key + dummy-code**だけでエンドツーエンドを確認する。Supabase OAuth authorize/token endpointは**絶対に呼ばず**、`exchangeDummy` は固定値だけで結果を返し、`gateway_authenticated:false`を固定。現行 `gateway_probe` の `supabase_connected:false`、`pc_connected:false`を維持する。Cloudflare実環境のsigned APIを試すのは後段の別ゲート。
4. 既存保存版2の20テストを壊さず、以下の拒否を追加: 未認証/別owner/別ブラウザ/CSRF・Origin不一致、期限切れ、競合するcomplete、二重claim、誤ったstate、過大レスポンス、非dummyコード、upstream failure、raw callback queryをSiteへ持ち込む動線、クライアントbundle/telemetryの秘密値混入。pendingは原子的に消費し、失敗や拒否の再試行でコード二重取得しない。
5. 実行可能なテスト、型、lint、buildと差分レビューを行い、保存版に留める。**Cloudflare Worker / D1 / Supabase OAuth App / redirect URI / Sites Hosted Secrets / Sites production deployment / PC を更新しない。** Secrets値を表示・貼付・リポジトリへ保存しない。現在の本番固定Pluginを壊さない。
6. Work環境にSites書込みCapabilityが無い場合は、必要なネイティブCapability名と拒否理由だけを記録して停止。Relayの監査コードをまた作り足すことや、「mock成功＝本番接続成功」とすることは禁止。レビューが必要なコード差分のみClaudeに共有し、秘密情報やユーザーセッションは共有しない。

### 次ゲート（このタスクには含めない）

保存版でdummy完走した後、実WorkerへSitesサーバーが署名付きPOSTするには両端の共有署名用Secretが必要。保存版2で確認済みのHosted Secrets 4件はOAuth用であり、Relay用Secretの存在は**未確認**。**既存Cloudflare Secretの値を取得・表示・再入力しない。** 共有キーの安全な配布/ローテーション、Live Workerとのバージョン整合、実効ログ設定、予算、本人による別承認を確認してから、ダミー実通信のみに進める。

そのさらに後でのみ、OAuth Appのredirect URI（Site→Worker）とPKCE一致、ログの残存リスクと本人同意を審査する。元のIssue #29の4つの完成条件は未達のまま維持。

**Workに渡す入口:** このセクションのURLと PR #42、Issue #29を参照し、作業範囲は「保存版2のSiteサーバー側dummy relay統合、mockのみ、未deploy」と指定する。

## 2026-10-20：Sites未公開「保存版3」のモック統合（Workの本人提供結果）

**証拠の境界:** 以下の保存・テスト実施結果はWork側の本人からこの会話に持ち込まれた報告。Sitesの保存版ソースやWork実行ログをこの通常チャットから直接読み直せていないため、`保存コミット bbb15b2`の完全性やテストログの内容を**独立再検証済みとは記述しない**。

- Work報告: 既存の本人確認・Cookie・CSRF・暗号化pendingを再利用し、署名付き`prepare`/`claim`とpending原子消費を保存版2へ統合。保存版3として`bbb15b2`へ保存し、**公開はしていない**。
- Work報告: 既存20件と新規12件で**32/32テスト成功**。型、lint、build成功。ブラウザ配布バンドルへの中継処理・秘密情報の混入は0件。
- **この通常チャットで実測:** 既存のKaito PC Agent Web Bridge Plugin `gateway_probe({})`を再実行し、`mode=fixed-diagnostic`、`supabase_connected=false`、`pc_connected=false`、`approvals_bypassed=false`が返った。これは**現在の公開Pluginが固定診断のまま**という確認であり、保存版3の統合・Hosted D1・Cloudflare実通信の成功証明ではない。
- Sites未公開保存版3へのアクセスはこの通常チャットで提供されないため、Sites内のソース監査/設定変更/プレビュー起動は未実施。実Worker通信、Hosted D1、実ブラウザ認証、実Cloudflareログの保持範囲、実OAuth、Supabase、家PCは未検証。
- **次の実行前ゲート:** WorkのSite編集/プレビュー権限、保存版3の現行ソース・build・環境、プレビューがowner-onlyか、Site内の署名鍵の**存在と方式**、既存Workerの署名鍵に対応できるか、Rate limit/nonce/D1残存行の影響、origin/redirectの一致を読み取りだけで確認する。既存Sites Hosted Secrets4件は**OAuth用**であり、Relay用共有署名鍵があるという確認は未取得。Worker Secretは値を読み取れず、元の値を抽出・コピー・GitHubへ転記しない。
- **まだ承認されていない操作:** 新しいSites Hosted Secret登録、既存Worker Secret上書き/ローテーション、Worker/D1設定変更、previewやproductionからの実Worker `prepare`/`claim`送信、Site公開、Supabase OAuth Redirect/本認証、PC操作。これらはこの報告だけを承認として扱わない。
- **最小限の次実験:** 本人が対象操作を承認し、正式なSite previewのowner-only経路と署名鍵が整った場合だけ、**real OAuthでないダミー**の`prepare 201 → dummy callback 303（固定URL・queryなし）→ claim 200 → replay 409`、pending/nonce/TTL/暗号文NULL、ブラウザ表示にcode/state非露出を記録。既存公開Pluginは固定診断のまま維持し、実OAuthやPCコマンドを呼ばない。
- Claude等の追加AIへ依頼するのは同じ障害が複数回再現し、原因を絞る追加レビューが必要な時のみ。Secret・未公開セッション・実OAuthデータを外部へ渡さない。


## 2026-10-20：Sites保存版3のプレビュー不成立確認（Work報告）

**結果の出所:** Workが本人に報告した調査・再テストの要約。通常チャットではSitesの内部プレビューや保存版3そのものを直接実行しておらず、独立実証とは区別する。

- **プレビューは起動しなかった**。内部QA用の`http://terminal.local:4173`は保存版3の既定で許可される本番Originと異なり、Sites本人セッションを引き継げることも未確認。保存版3実行入口の`start`/`complete`にはモックが結線されておらず、fail-closedで停止する。プレビューを「本人限定・実ブラウザ検証可能」と判断した以前の提案は取り下げる。
- **再検証はプロセス内モック統合テストの12/12 PASSのみ。** 同一owner/Cookie/Origin/CSRFの正負、正常系、原子的なpending消費、二重実行、別ブラウザ、未認証、期限切れ、不正URLを含む。使用DBは**メモリ内SQLite**、通信先は**同一プロセスのモック**。Hosted D1、実Worker、ブラウザのSiteセッション、実ログには一切アクセスしていない。
- Workの前回読み取りでは、SitesのHosted D1 Binding/テーブルはそれぞれ0件、OAuth用Hosted Secrets4件のみ、Relay署名用Secret未登録。今後この状態はSites nativeで再取得して確認する。保存版3は未deployで既存公開Site Pluginは固定診断のまま。
- **禁止する近道:** preview Originを本番許可リストへ無条件追加、owner認証やCookie/CSRFの迂回、テスト用headerを本番dispatchへ導入、モックを実OAuthの代用にして成功扱い、Secret値をChatGPT/GitHubへ転記。環境により認証・Originを変える時もProductionでfail-closedに保つ。
- **次の最短ルート:** プレビュー専用コードやモックテストを追加し続けず、Workで実Sites実行環境の正式なBinding/DBプロビジョニング方法、必要なD1 schema/migration、Relay用Secret安全配布/ローテーション、既存`src/sites-client.mjs`を現行Routesへつなぐサーバー限定通信アダプターと保護条件を**読み取り・実装計画**として確定。ログ/rollback/予算と、ダミー通信の最小テスト範囲・止め方を明記する。変更可能な既存Sitesの正式ネイティブ操作とCloudflare Workerを再利用し、新Siteや有料サービスは作らない。
- **別承認ゲート:** Hosted D1を作成/Bindingしschemaを適用すること、Relay署名用Secretの新規登録や変更、実WorkerへのダミーPOST、Sites preview/productionの実Deploy、Supabase OAuth、家PCの入力/GUIはいずれもこのWork報告で許可されたとはみなさない。現在のWorker Secretは読み出せず、既存keyと異なるkeyで接続は失敗するため、無承認の鍵変更は厳禁。必要な具体的変更を列挙して本人の明示承認を得る。
- 完成条件の判定は不変。実Site→Worker通信もSupabase→自作Agent→メモ帳も未検証でありIssue #29は継続。

