---
name: release
description: 「VSIX化して」と言われたとき、配布の区切りができたとき、GitHub Release を出すとき、配布の記録を残すときに読む。PowerShell で通す手順と、Marketplace は明示指示待ちという決まり。
---

# 配布（VSIX化 → 検証 → GitHub Release → 記録）

**GitHub Release までは指示を待たずに自走してよい。Marketplace への公開だけは作者の明示指示が要る**（この機械には vsce の PAT が無い。作者がブラウザから行う）。

## 手順

**PowerShell から走らせる**（Git Bash だと `verify:vsix` の `tar` が GNU tar になり ZIP を読めない）。**先に `ELECTRON_RUN_AS_NODE` を外す**（拡張機能ホストの環境変数を継ぐと Electron 製の子プロセスが即終了する）。

```powershell
$env:ELECTRON_RUN_AS_NODE = $null
npm run package:vsix      # 全リリースゲート（check → bundle:core → integration → web → audit）＋ vsce package
npm run verify:vsix       # 内容・隔離インストール・版の照合。SHA-256 が出る
```

- 出力の `release/novel-ai-assistant-<版>.vsix` と、バイト数・ファイル数・SHA-256 を控える
- VSIX に **`dist/mcp-server.mjs` は入り、`.mcp.json` は入らない**のが正しい（0.67.1 で方針を変えた。設計書6.87.8）。**束が無いと、作品へ書き出した MCP の登録が存在しないファイルを指す**——手元にリポジトリのある作者だけ繋がり、配布版では黙って繋がらなかった

```bash
gh release create v<版> "release/novel-ai-assistant-<版>.vsix" --title "v<版>——<一言>" --notes-file <ノート>
```

- ノートは CHANGELOG の該当版を作者向けに要約し、末尾に「版／テスト件数／SHA-256」を付ける。**日本語はファイルに書いて `--notes-file` で渡す**（引数に直接書かない）
- 前の配布から複数の版が溜まっていれば、まとめて1つの Release にしてよい（v0.65.3、v0.66.1 の前例）。**版はパッチのままでよい**——配布のために版を上げ直さない

## 記録

1. 引継ぎ書 8章の末尾に `### 【配布】<日付>：v<版> を GitHub Release に出した` を足す（ファイル名・バイト数・SHA-256・URL・何が入る版か・テスト件数・「Marketplace はまだ」）
2. 引継ぎ書「いまの状態」の版の行を `（VSIX＝GitHub Release は **v<版>**）` に直す
3. `node scripts/handoverToc.mjs`
4. `npm run test:unit` を通してから `docs: v<版> を配布した記録` でコミット・push
5. `SendUserFile` で VSIX を作者へ送る（`status: proactive`。Release の URL を添える）

## 判断

- **VSIX化を伴う配布は、規則ではマイナー版**（機能のまとまり・説明文の書き換え）。ただし既に上げたパッチ版で出すのは前例どおり可
- **配布の直前に引継ぎ書の版と実装が合っているかを見る。** 手元の版のほうが Marketplace より先へ進んでいることが常なので、「未公開」と早合点しない
- 配布後に見つけた不具合の修正は、次の区切りでまとめて出すか、その場で出すかを作者に聞く
