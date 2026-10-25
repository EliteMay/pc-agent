# Work向け: Sites保存版8のGET/POST確認（読み取りのみ・最小）

> **2026-10-25更新（この文書は当時の調査依頼として保存）:** GitHub PR #42の`src/sites-client.mjs`については `complete()` をPOST限定、Origin必須、保留状態の消費前にCSRF一致を要求するよう修正済み。GETのまま使うと405で拒否され、pendingは消費しない（模擬テストで確認）。この文書中の「GitHub基準コードがGETで状態変更」は**当時の旧コードについての説明**であり現在のブランチには当てはまらない。保存版10のSites実装・Hosted配信物との同一性、ブラウザのGET表示動線は**未検証**。PR #42は未マージ・未Deploy。

**目的:** GitHubの基準コード `gateway/cloudflare-callback-relay/src/sites-client.mjs`（`complete` が **GET** で状態変更）と、Site側の実装（Work報告では「GETは表示のみ、POSTで消費」）の食い違いが、保存版8で解消されているかを確認する。**保存版8は未公開。コード変更・保存・Deploy・Secret・Worker通信・Hosted DB書込みはしない。** 秘密値・Cookie・state/code/verifier/token・Owner情報は回答に含めない。

## 対象
- Site: 既存 `Kaito PC Agent Web Bridge`、保存版8 `307a341b18a899997cb61d201309af5d69a80e5b`（まず保存コミットがこのSHAであることを確認）。
- 見るファイル: Relay adapterの実装、`/connect/complete` と `/oauth/start` のルート処理、`lib/mcp.mjs` は不要。

## 確認項目（各項目に「はい／いいえ／確認不能」と該当ファイル名・行番号で答える）
1. `/connect/complete` の **GET** ハンドラは `consumePending`・`invalidatePending`・Worker `/claim` 呼び出し・DB書込みの**いずれも行わない**（表示のみ）。
2. `/connect/complete` の **POST** ハンドラが pending の消費と `/claim` を行い、**本人認証・HttpOnly Cookie由来のセッション・`Origin` が本番HTTPS固定値と完全一致・`x-oauth-csrf` が `pending.csrf` と一致** をすべて満たさない限り何もしない。`Origin` ヘッダー欠落（null）は拒否される。
3. 基準コードの `checkRoute` を取り込んでいる場合、`complete` のメソッド制約が **POST** になっている（GETのまま取り込むとPOSTが `method_not_allowed` になる、または状態変更GETが残る）。
4. `/oauth/start` は POST・CSRF・Origin検証を維持。
5. POST成功後の遷移は **query無しの303**（code/state/verifier/tokenをURL・Cookie・HTMLに出さない）。
6. Relay機能が既定OFF（Hosted Secretの `RELAY_SIGNING_KEY` 未登録、または機能フラグOFF）のとき、`gateway_probe` と既存ルートの応答が変わらない。
7. 外向き通信の宛先が固定の `https://kaito-oauth-callback-relay-dummy.k12m45k.workers.dev` のみで、`redirect: error`、timeout上限、応答サイズ上限が有効。
8. 保存版8に関するテスト（GET非破壊、POSTのCSRF/Origin拒否、二重実行拒否）が存在し、**GETでpendingが減らないこと**を直接検証している（修正前FAIL→修正後PASSの根拠）。

## 食い違いが見つかった場合
差分を出すだけにし、**自動修正しない**。「どの項目がいいえか」「基準コードとSiteのどちら側を直すか」を回答する。基準コード（GitHub側）の修正はClaudeが行う。

## 回答の形式
- 項目ごとの はい／いいえ／確認不能 と根拠（ファイル名:行）。
- 保存版8の保存コミットSHA、ソースとビルド成果物の一致確認の有無。
- 実行しなかった操作の一覧（Deploy・Secret・Worker通信を含む）。
