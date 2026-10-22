# 同梱ランタイムのセキュリティ（Node.js / .NET）— 2026-10-22

**範囲:** Windows配布バンドル（Manager＋Agent＋`Runtime\node.exe`）に同梱されるランタイム。ChatGPT/Sites/Cloudflare/Supabase・他プロジェクトは対象外。家PCへの更新・Release公開・本番変更は別承認。

## 1. 事実（家PCの読み取り検査、公式情報）
- 家PCのAgent（PID 6756）は **同梱 `Runtime\node.exe` = Node 22.23.3** で動作している（`releases\0.11.5\Runtime\node.exe`）。Windowsにインストールされた Node（`C:\Program Files\nodejs`、24.22.1へ更新済み）は**Agentに使われていない**。WindowsのNode更新は同梱Nodeへ反映されない。
- 過去のバンドル（0.6.1〜0.11.5）はすべて 22.23.3。
- ビルドは `actions/setup-node` の `node-version: '22'`（浮動）で、**ビルド当日にランナーが解決した22系**が同梱される。v0.11.5（2026-10-22 07:16Z）が 22.23.3 だったのは、22.23.4（2026-10-21公開）がまだ解決されなかったため。
- Node 22 の最新は **22.23.4**（セキュリティ版）。同日の 24系は 24.22.1、26系は 26.12.1。10件のCVE（High 4、Medium 3、Low 3）のうち、22系に影響するのは次の7件（Node公式の2026-10-21告知）:

| CVE | 重要度 | 内容（告知の題名から） | Agentでの到達可能性 |
| --- | --- | --- | --- |
| CVE-2026-111497 | High | Brotliデコーダの境界外書き込み（RCEの可能性） | 低〜中: Agentの通信は `fetch`（`accept-encoding: gzip, deflate` を実測、brは宣言しない）。通信相手が悪意ある `Content-Encoding: br` を返せる位置（TLS経路の乗っ取り等）にいる場合に限る。直接の `zlib` 使用なし |
| CVE-2026-106069 | High | TLSのホスト名検証回避（IPに緩く解決される名前） | 低: 接続先は固定のSupabaseドメイン名（IP形式ではない） |
| CVE-2026-105482 | High | `dns.resolve` がNULを含む名前を切り詰める | 該当なし: `dns.resolve` を使っていない |
| CVE-2026-106072 | Medium | 非正規IPv4でDNS SANがIPを認証 | 低: 同上 |
| CVE-2026-105481 | Medium | keep-aliveソケットが要求前の応答を処理 | 低: `http.Agent` を使わず、`fetch` のみ |
| CVE-2026-106074 | Medium | `randomUUID()` 等の乱数キャッシュがスナップショット/SEAで共有 | 該当なし: スナップショット/SEA不使用 |
| CVE-2026-106073 | Low | Permission Modelの `realpathSync` 回避 | 該当なし: Permission Model不使用 |

  あわせて OpenSSL 3.5.9、SQLite 3.53.4（Agentのジャーナルが使う `node:sqlite`）、undici 6.29.1 などの依存更新が含まれる。**到達可能性は低いが、深刻度Highを含むセキュリティ版の未適用であることに変わりはない。**
- `agent/` のnpm依存は**なし**（`dependencies` 空）。`npm audit` の対象外で、脆弱な依存はない。
- Managerの.NETランタイム（自己完結、`PcAgentManager.exe` 内に埋め込み）は **8.0.31**。.NET 8.0.32（2026-10-13）もセキュリティ版。**.NET 8 のサポートは 2026-11-10 に終了**する。

## 2. 変更（`feat/pin-bundled-node-22.23.4`）
- `.node-version` = `22.23.4` を唯一の基準にした（`setup-node` の `node-version-file`）。`agent-ci`・`manager-ci`・`release` が同じ版でテスト・ビルドする。
- `Test-PcAgentRelease.ps1` に `-MinimumNodeVersion` を追加。`manager-ci`・`release` の「配布物検証」は `.node-version` を下限として渡すため、**古い同梱Nodeは公開前に不合格**になる。引数なしの既存の使い方は不変。
- テスト: `.node-version` の形式、エンジン範囲との整合、ワークフローの固定（浮動メジャー禁止）、下限検査の配線。
- ローカル検証: 家PCの現行バンドル（22.23.3）は、下限 22.23.4 で**不合格**、22.23.3 で合格。

## 3. 配布への影響
- バンドルのNodeは新リリースでのみ更新される（実行中のAgentの実行ファイルは差し替えない）。更新アップデータは版が上がらないと新しいバンドルを提示しないため、**新版（0.11.6）の作成**が必要。
- 影響の確認事項: Game Safety・ローカル承認・既存アップデータはAgent/Managerのコードを変えないため影響しない。CIでは 22.23.4 上でAgentテスト全件とManagerのバンドルチェック（`--bundle-check`）、`Test-PcAgentRelease.ps1`（下限付き）が走る。

## 4. 未実施・要判断
- **.NET:** 8.0.32 への更新と、2026-11-10 のサポート終了への対応（.NET 10 LTS への移行）は、この端末にSDKが無く検証できないため今回は変更していない。まず `RuntimeFrameworkVersion` を固定する最小案をCIで検証するか、移行を計画するかを判断してほしい。
- v0.11.6 のRelease公開、家PCの更新は別承認。
