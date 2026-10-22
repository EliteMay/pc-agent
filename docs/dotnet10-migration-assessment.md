# .NET 10 LTS への Manager 移行評価（ブランチ `feat/dotnet10-manager`、2026-10-22）

**状態:** 評価と検証用ブランチ。**.NET 8 版（`main`、v0.11.x）は維持。.NET 10 版は十分な検証までReleaseしない。家PCの更新・本番変更なし。** この端末には .NET SDK がなく（ランタイムのみ）、ビルド・テストは CI で行う。

## 1. 公式情報（Microsoftのリリースメタデータ、2026-10-22取得）
| 項目 | .NET 8 | .NET 10 |
| --- | --- | --- |
| サポート種別 / 状態 | LTS / maintenance | **LTS / active** |
| サポート終了 | **2026-11-10** | **2028-11-14** |
| 最新パッチ | 8.0.32（2026-10-13、セキュリティ） | 10.0.13（2026-10-13、セキュリティ、SDK 10.0.402） |
| 現行Release（v0.11.6）の埋め込み版 | 8.0.31（1つ遅れ） | — |
- 対応Windows: Windows 11 24H2/25H2/26H1、Windows 10 1607（E）〜21H2（E）、Windows Server 2012〜2025（x64/x86/Arm64）。家PCは Windows 11 Pro 10.0.26300（対象内）。
- .NET 10 の破壊的変更（公式一覧）のうち、本アプリに関係しうるものは次のとおり。

## 2. 互換性の検査（コード調査）
| 公式の変更 | 本アプリ | 判定 |
| --- | --- | --- |
| 単一ファイルアプリが実行ファイルのディレクトリからネイティブライブラリを探さない／`DllImportSearchPath.AssemblyDirectory` の挙動 | P/Invoke は `kernel32.dll` の4件のみ（`WindowsJobObject.cs`）。システムライブラリで、独自ネイティブDLLなし | 影響なし |
| WinForms: `StatusStrip` の既定RenderMode、`TreeView` のチェックボックス、`MenuItem`/`ContextMenu`、`HtmlElement`、API廃止 | 該当APIの使用なし（grep）。`Application.SetHighDpiMode(SystemAware)` は継続して有効 | 影響なし |
| `System.Drawing` の `OutOfMemoryException` → `ExternalException` | `OutOfMemoryException` を捕捉する箇所なし | 影響なし |
| SDK: NuGet監査の推移的パッケージ、`NU1510`（剪定された直接参照）、`PackageReference` のバージョン必須 | 参照は `ProtectedData` 8.0.0 と `System.Management` 8.0.0（版指定あり）。警告は出うるが、`TreatWarningsAsErrors` なし | CIで警告を確認 |
| C# 14 の span オーバーロード解決 | 挙動が変わりうる一般的な項目。単体テストで確認 | CIで確認 |
| Unix のシグナル処理・OpenSSL・コンテナ | Windows専用 | 該当なし |
- **DPAPI（デバイストークンの保存）:** `ProtectedData.Protect/Unprotect`（`CurrentUser`、entropyなし）はOS機能でランタイム版に依存しない。ただし**実機のトークン復号は更新時の `--update-health-check`（Agent起動を30秒確認し、失敗なら自動ロールバック）で初めて実証される**。
- **Named Pipe、Game Safety、緊急停止、ローカル承認:** `System.IO.Pipes`・`Process`・ファイル存在判定・WinFormsダイアログ。公式の破壊的変更に該当なし。単体テストは Game Safety の状態遷移、緊急停止、更新（ZIPパストラバーサル、SHA-256）を含み、CIで .NET 10 上で実行される。**Named Pipe とダイアログの実動作は実機でのみ検証できる。**
- **アップデータ:** ZIPと `.sha256` の形式、アセット名、`UpdateBootstrapper` は不変。.NET 8 の旧Managerから .NET 10 の新Manager（自己完結）へ置き換わる更新経路は、同じ手順で動く（再起動後に新Managerが起動し、ヘルスチェック）。

## 3. 変更（最小）
- Manager と Manager.Tests の `TargetFramework` を `net10.0-windows` に。`manager-ci` と `release` の SDK を `10.0.x` に。
- 配布物検証に `-MinimumDotNetRuntime` を追加（埋め込み `runtimeconfig` の `Microsoft.NETCore.App` 版を、実行せずに読んで下限と比較）。下限は `.dotnet-runtime-version`（10.0.13）。
- 依存パッケージの版は据え置き（CIの警告を見て判断）。

## 4. 検証結果（CI、コミット `58a26ae`）
Manager CI（`windows-latest`、.NET 10 SDK）の全ステップが成功: Node テスト、Manager の restore／build、**Manager 回帰テスト（net10.0-windows、自己完結）**、publish、portable bundle の組み立て（新しい実行ファイルの `--bundle-check`）、**配布物検証（Node ≥ 22.23.4、埋め込み .NET ランタイム ≥ 10.0.13 の下限つき）**、成果物アップロード。Agent CI も成功。ビルド警告のアノテーションなし（GitHub Actions 側の Node 20 非推奨通知のみ）。

**未検証（実機でのみ確認可能）:** Named Pipe（Manager↔Agent）の実動作、ローカル承認ダイアログの表示、緊急停止の実機動作、Game Safety（ゲーム検出時の一時停止）、実際の `device-token.bin` のDPAPI復号、.NET 8 Manager から .NET 10 Manager への更新（`--update-health-check` とロールバック）、WinForms の見た目（DPI・フォント）。CIの成果物（net10の候補バンドル）はまだ家PCで起動していない。

## 5. Release前の条件（案）
1. 本ブランチをmainに入れる前に、`release` ワークフローが .NET 10 を前提にする点を承認（.NET 8 版のRelease手順は、`main` に入れた時点でなくなる）。
2. 候補バンドルを取得し、`Test-PcAgentRelease.ps1 -MinimumNodeVersion … -MinimumDotNetRuntime …` と `Compare-BundleToSource.ps1` を実行。
3. 家PCへの更新は本人が実行し、`--update-health-check` の通過（失敗時は自動ロールバック）、その後に Game Safety・緊急停止・ローカル承認の動作を確認。
4. 先に .NET 8 のまま 8.0.32 に更新するなら、`global.json`／`RuntimeFrameworkVersion` で固定する案（.NET 8 は 2026-11-10 までのため、短期の保険）。
