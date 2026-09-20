---
name: release
description: 「VSIX化して」と言われたとき、配布の区切りができたとき、GitHub Release を出すとき、配布の記録を残すときに読む。PowerShell で通す手順と、Marketplace は明示指示待ちという決まり。
---

# 配布（VSIX化 → 検証 → GitHub Release → 記録）

**GitHub Release までは指示を待たずに自走してよい。Marketplace への公開だけは作者の明示指示が要る**（取り消せないため）。この機械に vsce の PAT は無いが、**作者の Chrome からなら上げられる**（手順3）。

## 手順

### 0. 先に、Marketplace にいま出ている版を読む

```bash
node scripts/checkMarketplace.mjs
```

**引継ぎ書を見て済ませない。** Release ノートにも報告にも「Marketplace は **◯◯** のまま」と書くことになるので、**そこが文書の写しだと、外れていたときに嘘を配ることになる**（CLAUDE.md の失敗4）。鍵は要らず、こちらから作品や原稿は1文字も送らない。**数秒で終わる。**

**2026-09-20 に、この一手を飛ばして v0.70.9 を出した**（引継ぎ書の「0.69.10」をそのまま書いた。走らせたら結果は合っていたが、**当たっていたのは偶然**である）。**手順の頭に置いたのはそのためで、判断ではなく手順である。**

### 1. VSIX を作って検証する

**PowerShell から走らせる**（Git Bash だと `verify:vsix` の `tar` が GNU tar になり ZIP を読めない）。**先に `ELECTRON_RUN_AS_NODE` を外す**（拡張機能ホストの環境変数を継ぐと Electron 製の子プロセスが即終了する）。

```powershell
$env:ELECTRON_RUN_AS_NODE = $null
npm run package:vsix      # 全リリースゲート（check → bundle:core → integration → web → audit）＋ vsce package
npm run verify:vsix       # 内容・隔離インストール・版の照合。SHA-256 が出る
```

- 出力の `release/novel-ai-assistant-<版>.vsix` と、バイト数・ファイル数・SHA-256 を控える
- VSIX に **`dist/mcp-server.mjs` は入り、`.mcp.json` は入らない**のが正しい（0.67.1 で方針を変えた。設計書6.87.8）。**束が無いと、作品へ書き出した MCP の登録が存在しないファイルを指す**——手元にリポジトリのある作者だけ繋がり、配布版では黙って繋がらなかった

### 2. GitHub Release を出す

```bash
gh release create v<版> "release/novel-ai-assistant-<版>.vsix" --title "v<版>——<一言>" --notes-file <ノート>
```

- ノートは CHANGELOG の該当版を作者向けに要約し、末尾に「版／テスト件数／SHA-256」を付ける。**日本語はファイルに書いて `--notes-file` で渡す**（引数に直接書かない）
- 前の配布から複数の版が溜まっていれば、まとめて1つの Release にしてよい（v0.65.3、v0.66.1 の前例）。**版はパッチのままでよい**——配布のために版を上げ直さない

### 3. Marketplace へ公開する（**作者の明示指示があるときだけ**）

**vsce の PAT は要らない。作者の Chrome から、管理画面へ VSIX を上げる**（2026-09-20、0.71.1 で初めて通した手順）。

**内蔵ブラウザでは届かない。** 管理画面は Microsoft アカウントのログインが要る。内蔵のペインは作者の Chrome と別の入れ物なのでログインしていない。**Claude in Chrome（`mcp__claude-in-chrome__*`）を使う**——作者のログイン済みのセッションをそのまま借りる。

**ログアウトしていたらそこで止める。** パスワードも二要素認証のコードも**こちらからは入力しない**（迂回もしない）。作者に入ってもらってから再開する。

1. `navigate` で `https://marketplace.visualstudio.com/manage/publishers/nonahisa` を開く
2. `find`「拡張機能の行にある『…』メニュー、または Update / New version のボタン」→ `computer` の `left_click`（`ref` で押す。座標で押さない）
3. アップロードの画面が出る。「Click here to upload a package」は**押さない**——OSのファイル選択が開き、そこから先は操作できなくなる
4. `find`「ファイルを選ぶための input 要素（type=file）」→ **`file_upload` でその `ref` へ道を直接渡す**

```
mcp__claude-in-chrome__file_upload
  ref: <type=file の ref>
  paths: ["<リポジトリ>\\release\\novel-ai-assistant-<版>.vsix"]   ← Windows の道。JSON なので \ は2つ重ねる
```

5. **押す直前に、作者へもう一度確認する。** 上げるもの・バイト数・SHA-256・実機確認の済み具合を並べて出す。**公開は取り消せない**（版を非公開にはできるが、その間に入れた方には届く）
6. 上げたあと、検証（Verifying）に**数分から十数分**かかる。`get_page_text` で状態を読む（`screenshot` より確か）
7. **反映は `node scripts/checkMarketplace.mjs` で確かめる。** 画面の表示ではなく、手順0と同じ口で読む

## 記録

1. 引継ぎ書 8章の末尾に `### 【配布】<日付>：v<版> を GitHub Release に出した` を足す（ファイル名・バイト数・SHA-256・URL・何が入る版か・テスト件数・Marketplace へ出したかどうか）
2. 引継ぎ書「いまの状態」の版の行を `（VSIX＝GitHub Release は **v<版>**）` に直す
3. `node scripts/handoverToc.mjs`
4. `npm run test:unit` を通してから `docs: v<版> を配布した記録` でコミット・push
5. `SendUserFile` で VSIX を作者へ送る（`status: proactive`。Release の URL を添える）

## 判断

- **VSIX化を伴う配布は、規則ではマイナー版**（機能のまとまり・説明文の書き換え）。ただし既に上げたパッチ版で出すのは前例どおり可
- **配布の直前に引継ぎ書の版と実装が合っているかを見る。** 手元の版のほうが Marketplace より先へ進んでいることが常なので、「未公開」と早合点しない（**Marketplace の側は手順0で読む**）
- 配布後に見つけた不具合の修正は、次の区切りでまとめて出すか、その場で出すかを作者に聞く
