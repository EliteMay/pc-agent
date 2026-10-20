# Issue #29: PC側の完成度と実機E2E手順（2026-10-21、Claudeレビュー）

**証拠の区別:** 「読んだ」はリポジトリのコード・テスト、この家PCの読み取り専用確認（バージョン、設定のキー名、ログの種別）。「未実施」は実機での画面取得・GUI操作・Gateway経由の通信。Sites・Cloudflare・Supabase・家PCのGUIには一切操作していない。

## 1. 現在地

| 項目 | 状態 | 根拠 |
| --- | --- | --- |
| Agent（`agent/`）のコード | `capture_notepad` / `notepad_gui`（open・click・type・scroll・save）実装済み、ローカル承認必須、Game Safety（VALORANT）検査あり | 読んだ。Agentテスト100/100→本変更後103/103 PASS |
| 家PCの導入版 | Agent/Manager **0.11.4**（`%LOCALAPPDATA%\PcAgent\releases\0.11.4`）。Manager・Agent稼働中、ログイン自動起動・Game Safety有効 | `scripts/Test-PcAgentRelease.ps1` 16/16 PASS（読み取り専用） |
| 0.11.4に含まれる機能 | 画面取得・GUI操作・ウィンドウ可視性修正（#31〜#34）を含む | `v0.11.4` = `31a4c1b` |
| 0.11.5との差 | 「期限切れのローカル承認を拒否」する安全修正（#35）のみ。**GitHub Releaseは v0.11.4 が最新で、v0.11.5は未公開** | `git diff v0.11.4 main`、Release API |
| Gateway（`gateway/oauth-pc-agent`）のコード | 上記ツールを公開済み（VERSION "9"）。**本番にデプロイ済みの版は未確認**（Supabase認証が必要で当方は未接続） | 読んだ |
| 実機での画面取得・GUI操作 | **未実施**。`PrintWindow`のNotepad（Win11 XAML）での描画、フォーカス移動、`SendInput`到達は実測なし | Issue #29コメント、docs |
| ChatGPT→Gateway→Agentの通信 | 通常ChatGPTのPlugin経路は未接続（Siteは固定診断のみ） | Issue #29 |
| Desktop Commander連携 | `manage_desktop_commander_remote=true`。起動時にDesktop Commander Remoteを**Managerが起動**する（Game Safety用の任意機能） | `manager.json`のキー名、`manager.log` |

## 2. 今回見つけて直した実機E2Eの障害（未実機検証）

画像座標とクリック座標が一致しなかった。`capture_notepad`は**ウィンドウ全体**（タイトルバー含む）を最大960×720へ縮小し、縮小後の幅と高さだけを返していた。一方`notepad_gui`の`click`は**クライアント領域**の座標を要求する。縮小率とタイトルバー分のずれを補正する情報がなく、画像で見た位置を指定するとクリックが外れる。

修正: 取得結果に元ウィンドウのサイズとクライアント領域の位置・サイズを追加（`geometry`）。Agentが検証し、Gatewayが変換式付きで返す。`click`の仕様は不変。詳細は[画面取得文書](issue-29-screen-capture.md)。あわせて、PowerShellヘルパーのコマンドライン長がWindows上限（32,767文字）に近い（GUIヘルパーは約30,500文字）ため、上限に対する余裕を検査するテストを追加した。

**仮説（未検証）:** 表示倍率が100%以外の画面では、DPI非対応のPowerShell経由の座標と`PrintWindow`の描画サイズがずれる可能性がある。この家PCの主画面は100%（DPI 96）で、倍率違いは未検証。

## 3. 実機E2Eの手順（本人が行う。各ステップでローカル承認を省略しない）

前提: 無害なテスト用テキスト（秘密情報を含まない）、VALORANT停止中、Managerの緊急停止が使えること。

1. （任意・推奨）0.11.5へ更新。Releaseが公開されたらManagerの更新確認で更新する。更新前に`scripts/Test-PcAgentRelease.ps1`で現行バンドルを検査。
2. 本番Gatewayが本ブランチの版か確認（Supabase側。`gateway/oauth-pc-agent`のVERSIONと、`capture_notepad`/`notepad_gui`の公開）。未デプロイの場合のみ、デプロイは別承認。
3. Desktop Commanderを停止し、Managerの`manage_desktop_commander_remote`を一時的にOFFにして再起動後も起動しないことを確認。
4. 経路は、まず既存の**デスクトップ限定Plugin**（v0.3.0）でも`ping`→`capture_notepad`→`notepad_gui`（open→click→type→save）→`capture_notepad`→`read_text_file`を試せる。これはSites経路とは独立にPC側（条件2・3）を検証できる。ただしIssue #29の「通常ChatGPT」にデスクトップアプリを含めるかは**本人の判断**。
5. 各コマンドは**60秒以内**にManagerで承認する（ゲートウェイが付ける有効期限）。期限後に承認すると0.11.5では拒否される。
6. 取得画像の`geometry`から`click_mapping`の式で座標を計算し、クリックが意図した位置に入ることを確認。`save`後は必ず再取得とファイル読み直しで検証（`dispatched:true`は成功の証明ではない）。

## 4. 残る障害

- 実機でのキャプチャ・入力は未実測（Win11 Notepadでの`PrintWindow`、フォーカス、`SendInput`）。
- v0.11.5未公開（Release作成は別承認）。
- 本番Gatewayのデプロイ版が未確認。
- Webの通常ChatGPTからGatewayへ至る経路（Sites）が未完成。
- Gatewayの型検査（`deno check`）はこの端末で実行できず、CIのみ。
