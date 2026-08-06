# VSIX Worktree Exclusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** リポジトリ内のlinked worktreeをVSIXから確実に除外し、v0.0.2の公開物を8ファイルへ戻す。

**Architecture:** VSIXの収録境界を管理する`.vscodeignore`へworktreeルートの再帰除外を1行追加する。実際の`vsce`によるsentinel検査と既存のリリースゲートで動作を証明する。

**Tech Stack:** VS Code Extension Manager (`vsce`), PowerShell, npm, GitHub Actions

## Global Constraints

- `.env`、Sakura AI workflow、Secret、製品コード、原稿処理は変更しない。
- 失敗した91MBのVSIXは公開しない。
- 修正は非ドラフトPRでmainへ反映し、main CI成功後に公開物を再生成する。

---

### Task 1: linked worktreeをVSIXから除外する

**Files:**
- Modify: `.vscodeignore`

**Interfaces:**
- Consumes: `vsce`のignoreパターン
- Produces: `.worktrees/`以下を配布候補から除外するパッケージ境界

- [ ] **Step 1: sentinelで失敗を再現する**

```powershell
$files = npx --no-install vsce ls --no-dependencies
$leaked = @($files | Where-Object { $_ -like '.worktrees/*' })
if ($leaked.Count -gt 0) { throw "VSIX candidate leaks repository-local worktree files" }
```

Expected: `.worktrees/package-sentinel/DO_NOT_SHIP.txt`が検出されexit 1になる。

- [ ] **Step 2: 最小修正を加える**

`.vscodeignore`へ次を追加する。

```text
.worktrees/**
```

- [ ] **Step 3: sentinelが除外されることを確認する**

Step 1と同じコマンドを実行する。

Expected: worktreeファイルが0件でexit 0になる。

- [ ] **Step 4: リリースゲートを検証する**

```powershell
npm run ci
npm run package:vsix
npm run verify:vsix
git diff --check
```

Expected: 全コマンドがexit 0、VSIXは8ファイル、identityは`local.novel-ai-assistant@0.0.2`になる。

- [ ] **Step 5: commit・push・非ドラフトPR・main CIを完了する**

```powershell
git add .vscodeignore docs/superpowers/specs/2026-08-07-vsix-worktree-exclusion-design.md docs/superpowers/plans/2026-08-07-vsix-worktree-exclusion.md
git commit -m "fix: exclude worktrees from VSIX"
git push -u origin fix/exclude-worktrees-from-vsix
```

Expected: PRとmerge後mainのWindows CIがsuccessになる。
