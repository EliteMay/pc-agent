# Gateway v10 デプロイ準備と、Desktop Commander停止下の実機テスト計画（2026-10-22）

**状態:** 準備と検査のみ。**本番Gatewayのデプロイ、Desktop Commanderの停止・設定変更、PCのGUI操作は未実施**で、それぞれ個別の本人承認が必要。

## 1. 証拠の区別

**確認済み（ChatGPTのSupabaseコネクタによる読み取り、本人報告）**
- `kaito_pc_devices` のAgentハートビート 2026-10-22 16:34:59 JST、`agent_version` 0.11.5。
- 本番 `kaito-pc-agent-oauth-readonly` は ACTIVE、内部 `VERSION` は **9**、`geometry`・`click_mapping` は未実装。

**確認済み（Claudeの検査）**
- GitHub `main`（`0931df3`）の `gateway/oauth-pc-agent/index.ts` は `VERSION "10"` で両機能を実装済み。
- 本番の関数は、認証なしGETに関数自身が `WWW-Authenticate: Bearer resource_metadata=…` を返す。デバイス関数は認証なしGETが200で `{"version":"2"}`。このためプラットフォームの `verify_jwt` は**両関数とも false** で動いていると推測できる（推測。コネクタで設定値を読めば確定）。
- `a7ac42f` と `main` の差分は、バージョン値、`notepad_gui` の説明文、`captureGeometry()` と `mcpCaptureResult()` への追加のみ。認証（`withSupabase`・`withOAuthProtectedResource`・`isAllowedUser`）、ユーザー照合、有効期限、承認要否、ツール集合（READ_ONLY/WRITE/GUI/SENSITIVE/DEVELOPMENT）に変更は**ない**。
- DBマイグレーションは 2026-10-07 以降なく、`v9` 系のどの履歴版とも同一スキーマ。
- 応答互換性（実行して検証）: 本番候補の `a7ac42f` と `main` の `mcpCaptureResult` を同じ入力で比較。**幾何情報なし（古いAgent 0.11.4）／不正・部分・範囲外の幾何情報では、v10の応答はv9とバイト単位で同一**。有効な幾何情報では、画像コンテンツと他のメタデータは不変で、`structuredContent.geometry` が増えるだけ。`click_mapping` はAgent供給値ではなくGatewayの定数（Agentが `click_mapping` を偽装して送っても無視）。
- 依存: `npm:@supabase/server@^1.6.0`（最新 1.9.2、2026-10-12）、`npm:@supabase/middleware@^0.5.0`（0.5系は 0.5.0 のみ）。1.9.1（10/5）→1.9.2 の差は**ドキュメントコメントとビルド生成ファイル名のみで、実行ロジックの変更なし**（公開パッケージの内容比較）。ただし 1.9.1 のコメントに「OAuth Protected Resource の面はalpha、minor版で設定形式が変わりうる」とあり、範囲指定のままだと将来のminor更新でデプロイごとに挙動が変わりうる。

**仮説・未確認**
- 本番ソースが履歴上のどのコミットと一致するか（候補は `355374d`・`3200852`・`a7ac42f`）。→ §2。
- 本番のデバイス関数（`pc-agent-device`）が #31 の「未配信キャプチャ削除」を含むか。→ §2。
- `verify_jwt`、entrypoint、import map の本番設定値。→ §2。

## 2. 本番ソースの特定（ChatGPT側コネクタで読み取り・実行不要で破壊なし）
各関数の本番ソースを取得し、次の正規化でSHA-256を計算して下表と照合してほしい（改行をLFに統一、末尾は改行1つ）。

```python
import hashlib
t = source.replace("\r\n", "\n").rstrip("\n") + "\n"
print(hashlib.sha256(t.encode("utf-8")).hexdigest())
```
同時に、各関数の `version`（Supabase側の数値）、`verify_jwt`、`entrypoint_path`、import map の有無、`updated_at` を記録する。

**oauth-pc-agent（`kaito-pc-agent-oauth-readonly`）**

| commit | 日付 | VERSION | 正規化SHA-256 | 内容 |
| --- | --- | --- | --- | --- |
| `6383d78` (main) | 2026-10-21 | "10" | `32a1bf191ecbc4c6f4d311f753975406ceb871b6b43868745464daf5b91cfbb1` | 幾何情報（デプロイ対象） |
| `b324509` | 2026-10-21 | "9" | `2336279a85732e110e22d582a2f63ba4fe63a9ef161471313f2fad575abcfc7c` | 幾何情報（VERSION未更新の途中版） |
| `a7ac42f` | 2026-10-08 | "9" | `4802691a3c4f59c00781841c02834aa1b9ef3cbba76baf17c5343f4c4663b734` | + notepad_gui（#33） |
| `3200852` | 2026-10-08 | "9" | `f240dcd9f1fecb67b8debe411856fb13dcbd1f7269bdf57ae8ec405d2ca10c2a` | + capture_notepad（#31） |
| `355374d` | 2026-10-07 | "9" | `3e8ccdb23a90b90d58bd162e8da2184402ef4aa72874a9879d5f2df7e316f17f` | v0.9（キャプチャ/GUI前） |

**pc-agent-device**

| commit | 日付 | VERSION | 正規化SHA-256 | 内容 |
| --- | --- | --- | --- | --- |
| `3200852` (= main) | 2026-10-08 | "2" | `60d62dbae9a84c295e54a887312f9ba1a9da25bbfdc67f228a049977e6768e81` | + 未配信キャプチャの削除（#31） |
| `c909c66` | 2026-10-07 | "2" | `276e0ab4a74c476860a1666ce4ef488440e428cbe269783b67cd503b5445e6a8` | 削除処理なし（VERSIONは同じ "2"） |

**判定:** 本番の `oauth-pc-agent` が `a7ac42f` と一致すれば、v10デプロイで変わるのは§1の差分だけ。`355374d` または `3200852` と一致する場合は、v10デプロイが**キャプチャ／GUIツールの追加も同時に行う**ため範囲が広がる（その場合は別途承認を取り直す）。`pc-agent-device` が `c909c66` なら、キャプチャ経路を使う前にこの関数も更新が必要（現在の本番にキャプチャ系ツールが既にあるなら、先に更新されているべき）。ハッシュが一致しない場合は、差分を取り直して判断する。

## 3. デプロイ対象と手順案（承認後・未実施）
**対象は `gateway/oauth-pc-agent/index.ts`（main `0931df3` 時点、1ファイル）のみ。** `pc-agent-device`・DB・Secret・環境変数・Sites・Cloudflareは変更しない。

事前（読み取り・承認不要）:
1. §2 を実施し、本番の関数バージョン番号、`verify_jwt`、entrypoint、ソースSHA-256を記録（これがロールバックの基準）。
2. 現在の本番の認証なしGET応答を記録済み（401＋`resource_metadata`）。

デプロイ時の必須条件（承認時に明示する）:
- 関数名 `kaito-pc-agent-oauth-readonly`、entrypoint `index.ts`、**`verify_jwt` は本番と同じ値（推測では false）**。コネクタの既定が true の場合に黙って上書きされると、認証なしの探索（`/oauth-protected-resource`）とChatGPTのPlugin接続が壊れる。
- 依存は §1 のとおり再解決される。実行ロジックの差はないと確認済みだが、厳密に固定したい場合は `@supabase/server` を `1.9.1`（本番が10/7〜8のデプロイなら解決された版）または `1.9.2` に固定する案がある。これは**ソース変更を伴う別PR**であり、今回のデプロイ範囲には含めない。

事後（読み取り中心）:
- 認証なしGETが従来どおり401＋`WWW-Authenticate: Bearer resource_metadata=…`、メタデータURLが従来どおりの内容。
- 認証済みのGETで `version: "10"`、`tools/list` が従来と同じツール集合（`notepad_gui` の説明文のみ異なる）。
- `ping`（読み取り専用）が従来どおり成功。関数ログにエラーなし。Agentのハートビート継続。
- キャプチャの実測は §4 まで行わない。

ロールバック: 本番の旧ソース（§2で特定したコミットのファイル）を、同じ設定（`verify_jwt` など）で再デプロイ。Supabase側の関数バージョン履歴から戻せるかは未確認のため、**再デプロイを正規手順と想定**する。DB・Agentへの影響はない（応答の追加フィールドのみのため、デプロイ中の新旧混在でも互換）。

## 4. Desktop Commander停止下の実機テスト計画（未実施）
前提: Agent/Manager 0.11.5（導入済み）、Gateway v10（承認・デプロイ後）、テスト用の無害なテキストファイル（許可ルート内、秘密情報なし）、VALORANT停止中。毎コマンドManagerで**60秒以内**にローカル承認（迂回しない）。

| 段階 | 内容 | 経路 | 承認 | 合格条件 |
| --- | --- | --- | --- | --- |
| 0 | `Test-PcAgentRelease.ps1` と `Test-PcAgentIndependence.ps1`（停止前は警告のみ） | ローカル | 不要 | 全PASS |
| 1 | 本人がManager設定でDesktop Commander管理をオフ→Desktop Commanderを停止→`Test-PcAgentIndependence.ps1 -RequireDesktopCommanderStopped` | ローカル | **要（本人）** | 全PASS（Desktop Commanderなし、AgentがManager直下） |
| 2 | `ping` → `capture_notepad`（無害なNotepadを1つ開いた状態） | 補助: 既存デスクトップ限定Plugin／本命: Web経路 | ローカル承認 | 画像が表示され、`geometry` と `click_mapping` が付く |
| 3 | 画像上の既知位置を `click_mapping` で変換→`notepad_gui` click→`type`（短い固定文字列）→再度`capture_notepad` | 同上 | 毎回 | 文字がクリック位置（改行位置）の期待どおりに入る。座標がずれる場合は中止して原因調査 |
| 4 | `scroll`、`save`→`read_text_file`で保存内容を確認 | 同上 | 毎回 | 保存内容が一致（`dispatched:true` だけで成功としない） |
| 5 | Game Safety・緊急停止の確認 | ローカル | 要（本人） | 緊急停止でAgentが停止し、解除まで復帰しない。Game Safetyはゲーム検出時の一時停止（ゲームを起動しない代替確認は別途設計） |

中止条件: 承認の期限切れ（60秒超）が続く、フォーカス喪失、想定外のウィンドウ、`GUI_ACTION_FAILED`、キューエラーの連続。いずれも再試行を乱発せず、ログ（`manager.log` の種別のみ）を確認して原因を特定する。

**Issue #29の4条件との対応:** 段階2が条件1・2、段階3〜4が条件3、段階1〜4の全体がDesktop Commander停止下のE2E（条件4）。**ただし第1目標は「Chromeを含む通常ChatGPTから自作Plugin経由」であり、デスクトップ限定Pluginでの成功はWeb経路の代わりにならない。** 条件の完走には、Web経路（Sites）の完成と同じ手順での再試験が必要。

## 5. 承認を求める操作（まとめ）
1. **本番Gatewayデプロイ（`oauth-pc-agent` 1ファイル、`main` `0931df3`、`verify_jwt` は現行値を維持）** — §2の照合で本番が `a7ac42f` と一致した後。
2. （条件付き）`pc-agent-device` の更新 — §2で未更新と判明した場合のみ、別承認。
3. Desktop Commander管理のオフと停止（本人）— §4 段階1。
4. 実機GUIテスト（段階2〜5）— 毎コマンドのローカル承認を前提に、実施の可否。
