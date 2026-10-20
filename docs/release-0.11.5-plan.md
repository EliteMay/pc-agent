# v0.11.5 配布計画（最小・既存アップデータ利用）

**状態:** 計画と配布前検証ツールのみ。マージ・Release公開・家PCの更新・Supabase本番デプロイは**いずれも未実施**で、それぞれ個別の本人承認が必要。

## 1. 何を届けるか（事実）
- 家PCは Agent/Manager **0.11.4**。導入済みAgentファイルは `v0.11.4` タグのソースとバイト単位で一致する（`scripts/Compare-BundleToSource.ps1`、2026-10-21）。
- `main` は **0.11.5**（期限切れのローカル承認を拒否する安全修正 #35 を含む）。GitHub Releaseは v0.11.4 が最新で、**v0.11.5 は未公開**。0.11.4 との差は `agent-runtime.js` と `package.json` のみ。
- PR #43（`feat/capture-click-geometry`）は画面取得にクライアント領域の幾何情報を追加する。Agent（`capture-notepad.js/.ps1`）とGateway（`oauth-pc-agent`、`VERSION` を "9"→"10"）が対象。

## 2. 既存アップデータの性質（コードを読んだ事実）
- Managerの「更新確認」ボタン（**本人操作**）で `releases/latest` を取得。draft・prereleaseは無視。zipと `.sha256` の2資産が必須で、ダウンロードURLはGitHub HTTPSに限定、SHA-256を検証。
- 適用は旧Managerの終了待ち→新Manager起動確認→失敗時は旧版へロールバック（`UpdateBootstrapper`）。旧バージョンのディレクトリは `%LOCALAPPDATA%\PcAgent\releases\` に残る。
- したがって「Releaseを公開」しても、家PCは**本人が更新確認を押して確認するまで更新されない**。

## 3. 最小の順序
| # | 作業 | 承認 | 目的 |
| --- | --- | --- | --- |
| 1 | PR #43 を CI 成功のうえレビュー・マージ | 要 | 0.11.5 に幾何情報を含める（0.11.5は未公開なので版は上げない） |
| 2 | `main` の Manager CI が作る成果物 `pc-agent-manager-win-x64`（CI内で `Test-PcAgentRelease.ps1` 合格済み）を取得 | 不要（GitHub画面から本人がDL。当方は認証なしでは取得不可） | 配布前の成果物検証 |
| 3 | 取得した成果物を展開し、下の「配布前検証」を実行 | 不要（読み取りのみ） | ソースとの一致・版・SHA確認 |
| 4 | `v0.11.5` タグ作成 → Releaseワークフローが zip＋sha256 を公開 | **要（公開）** | 既存アップデータの入力 |
| 5 | 本人が Manager の「更新確認」→ 0.11.5 へ更新 | 要（本人操作） | 家PC更新 |
| 6 | 更新後の確認（下記） | 不要 | 実行環境の確認 |
| 7 | Supabase Gatewayを `VERSION "10"` の版にデプロイ | **要** | 画面取得結果に幾何情報を載せる |

Gatewayは新旧どちらの順でも動く: 古いAgent（0.11.4）は幾何情報を送らず、Gatewayは省略して返す。新Agentに古いGatewayでも、未知フィールドは無視される。

## 4. 配布前検証（読み取りのみ・実行手順）
```powershell
# 成果物を展開したフォルダを $bundle、対象コミットのチェックアウトを $src とする
.\scripts\Test-PcAgentRelease.ps1 -BundleRoot $bundle                 # 版・Manager SHA-256・bundle-check
.\scripts\Compare-BundleToSource.ps1 -BundleRoot $bundle -SourceRoot $src   # Agentファイルがソースと一致
```
合格条件: 両方 exit 0、Agentのバージョンが `0.11.5`、`$src` が `main` のマージコミット。

## 5. 更新後の確認と戻し方
- `.\scripts\Test-PcAgentRelease.ps1 -BundleRoot "$env:LOCALAPPDATA\PcAgent\releases\0.11.5" -RequireLoginStartup -RequireGameSafety`
- `.\scripts\Test-PcAgentIndependence.ps1`（Desktop Commander停止下の検証は `-RequireDesktopCommanderStopped`）
- 失敗時: アップデータの自動ロールバックを待つ。必要なら旧 `releases\0.11.4` の `PcAgentManager.exe` を起動（旧版は削除されない）。Gateway側は `VERSION "9"` の版へ再デプロイ（別承認）。

## 6. 範囲外・未検証
- 実機での画面取得・GUI操作の本番E2E（承認キュー経由）は未実施。
- Releaseワークフローの `windows-latest` ビルドが現行mainで成功するかは、タグを切るまで未実測（Manager CIの同等手順は成功）。
