---
name: desk-editor
description: 止めている（2026-10-03）。`desk/`（VS Code の外で動く原稿エディターと読み書き役）を再開するとき・直すときに読む。出先の原稿エディターはページ版（設計書6.116）が引き継いだ。
---

# 内蔵ブラウザの原稿エディター（desk）——止めた記録

`desk/` は、VS Code を開かずに Claude のデスクトップアプリの内蔵ブラウザ（右の枠）で書くための試作（2026-09-26、設計書6.112）。手元の小さな読み書き役が作品フォルダーを読み書きする。**2026-10-03 に止めたまま残している。**

**2026-10-05 から、出先で書く原稿エディターは claude.ai のページ（Artifact）になった**（設計書6.116）。雛形は `media/outbox/editor.html`、作り方（publish のときの `capabilities`）は `docs/skills/novel-assist.md` の「出先の原稿エディター」。出先の書き物はページ版を育てる。ページ版も AI は入れない。

## 再開するとき

- 読む所：`desk/`（`start.mjs`・`server.mjs`・`pageShim.mjs`・`vscodeShim.mjs`）、設計書6.116、`docs/skills/novel-assist.md`
- 起動：`.claude/launch.json`（git の管理外）の `desk` を右の枠の `preview_start`（名前 `desk`）で開く。中身は `node desk/start.mjs --work <作品フォルダー> --port 4870`
- 配るなら Claude Code のプラグインと VSIX 同梱の両方（作者の決定 2026-09-26）。ただし `desk/` は今は VSIX に入れない（`.vscodeignore` の `desk/**`）

## 決まり（崩さない）

- **読み書き役が書き込むのは、作者が打った文字だけ。** AI（このチャットの Claude を含む）が原稿を書き換える口は作らない。作者が「直して」と言っても、直す文を示し、作者が画面で打つか採る（MCP は読む・測る・提案するだけ）
- **保存は原稿を壊さない形で**（実装ルール1）：ハッシュ照合・文字コードと改行の保持・変わった所だけの書き戻し。競合マーカーのあるファイルは開くだけで書かない
- 読み書き役は **localhost だけ**で待ち受ける
- **試す作品**：確認用コピーの作品をさらに scratchpad へ写したものだけで開く。作者の原稿（`Documents\novel\`）で開くのは、作者が明示したときだけ
