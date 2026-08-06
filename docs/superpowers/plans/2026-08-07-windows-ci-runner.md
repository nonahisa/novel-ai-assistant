# Windows CI Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Windows前提の安全性テストを正しいGitHub Actions runnerで実行し、v0.0.2を検証済みVSIXとして公開する。

**Architecture:** 製品コードとテストは変更せず、CIの`quality`ジョブだけをWindowsへ合わせる。PRとmainの実CIを受け入れテストとし、成功したmainから一度だけVSIXを生成して公開物と再取得物を同一SHAで監査する。

**Tech Stack:** GitHub Actions, PowerShell, Node.js 22, npm, Vitest, `@vscode/test-electron`, `@vscode/vsce`, GitHub CLI

## Global Constraints

- ローカル`.env`は読まない、作らない、変更しない。
- `SAKURA_AI_ACCOUNT_TOKEN`と手動Sakura workflowは変更しない。
- PRは非ドラフトで作成する。
- 製品コード、原稿、作者編集データ、テスト期待値は変更しない。
- 公開用VSIXは最終mainから一度だけ生成し、その後は再ビルドしない。

---

### Task 1: CI runnerをWindowsへ合わせる

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `package.json`の`ci`、`package:vsix`、`verify:vsix` scripts
- Produces: Windows runnerで全リリースゲートを順番に実行する`quality` job

- [ ] **Step 1: 変更前の失敗を確認する**

Run:

```powershell
gh run view 31131301410 --repo nonahisa/novel-ai-assistant --json conclusion,headSha,jobs
```

Expected: `b3f1548265a688eeca83278980e8fb27ce9ebba5`のUbuntu jobが`failure`で、`npm run ci`が25件のWindowsパス関連テスト失敗を報告する。

- [ ] **Step 2: Windows基準を確認する**

Run:

```powershell
npm ci
npm run ci
```

Expected: unit 269/269、quality、coverage、build、integration 5/5、audit 0が成功する。

- [ ] **Step 3: workflowを最小変更する**

```yaml
jobs:
  quality:
    runs-on: windows-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run ci
      - run: npm run package:vsix
      - run: npm run verify:vsix
```

- [ ] **Step 4: ローカルの全ゲートを再実行する**

Run:

```powershell
npm run ci
npm run package:vsix
npm run verify:vsix
git diff --check
```

Expected: 全コマンドがexit 0で、VSIX identityが`local.novel-ai-assistant@0.0.2`になる。

- [ ] **Step 5: 修正をコミットする**

```powershell
git add .github/workflows/ci.yml docs/superpowers/plans/2026-08-07-windows-ci-runner.md
git commit -m "ci: run release gates on Windows"
```

### Task 2: 非ドラフトPRを通してmainへ反映する

**Files:**
- No repository file changes

**Interfaces:**
- Consumes: `fix/windows-ci-runner` branch
- Produces: greenなPR checkとmain push check

- [ ] **Step 1: branchをpushして非ドラフトPRを作成する**

```powershell
git push -u origin fix/windows-ci-runner
gh pr create --repo nonahisa/novel-ai-assistant --base main --head fix/windows-ci-runner --title "ci: run release gates on Windows" --body "Windows前提の永続化安全性テストにCI runnerを合わせます。製品コード・テスト・Sakura AI workflow・Secretは変更しません。検証: npm run ci / npm run package:vsix / npm run verify:vsix"
```

Expected: `isDraft: false`のopen PRになる。

- [ ] **Step 2: PR CIを監視する**

```powershell
$prNumber = gh pr view fix/windows-ci-runner --repo nonahisa/novel-ai-assistant --json number --jq .number
gh pr checks $prNumber --repo nonahisa/novel-ai-assistant --watch --fail-fast
```

Expected: Windows `quality` jobがsuccessになる。

- [ ] **Step 3: PRをmergeしmain CIを監視する**

```powershell
$prNumber = gh pr view fix/windows-ci-runner --repo nonahisa/novel-ai-assistant --json number --jq .number
gh pr merge $prNumber --repo nonahisa/novel-ai-assistant --merge
$mergeSha = gh pr view $prNumber --repo nonahisa/novel-ai-assistant --json mergeCommit --jq .mergeCommit.oid
$mainRunId = gh run list --repo nonahisa/novel-ai-assistant --branch main --workflow CI --limit 20 --json databaseId,headSha --jq ".[] | select(.headSha == `"$mergeSha`") | .databaseId" | Select-Object -First 1
gh run watch $mainRunId --repo nonahisa/novel-ai-assistant --exit-status
```

Expected: PRがmerged、main merge commitのCIがsuccessになる。

### Task 3: v0.0.2を公開して配布物を監査する

**Files:**
- Generated: `release/novel-ai-assistant-0.0.2.vsix`
- Generated: `release/v0.0.2-notes.md`

**Interfaces:**
- Consumes: greenな`origin/main`
- Produces: annotated tag `v0.0.2`、非ドラフトGitHub Release、検証済みVSIX asset

- [ ] **Step 1: mainを同期して公開物を一度だけ生成する**

```powershell
git pull --ff-only origin main
npm ci
npm run ci
npm run package:vsix
npm run verify:vsix
node scripts/prepareReleaseNotes.mjs
Get-FileHash release/novel-ai-assistant-0.0.2.vsix -Algorithm SHA256
```

Expected: 全ゲート成功、notes記載SHAとVSIX SHAが一致する。この後は再パッケージしない。

- [ ] **Step 2: tagとReleaseを公開する**

```powershell
git tag -a v0.0.2 -m "Release v0.0.2"
git push origin v0.0.2
gh release create v0.0.2 release/novel-ai-assistant-0.0.2.vsix --repo nonahisa/novel-ai-assistant --title "v0.0.2" --notes-file release/v0.0.2-notes.md --verify-tag
```

Expected: Releaseは`isDraft: false`、`isPrerelease: false`で、VSIX assetが1件だけ付く。

- [ ] **Step 3: Release assetを再取得して実インストールする**

```powershell
$auditRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("novel-ai-assistant-v0.0.2-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $auditRoot | Out-Null
gh release download v0.0.2 --repo nonahisa/novel-ai-assistant --pattern novel-ai-assistant-0.0.2.vsix --dir $auditRoot
$downloadedVsix = Join-Path $auditRoot "novel-ai-assistant-0.0.2.vsix"
Get-FileHash $downloadedVsix -Algorithm SHA256
code --install-extension $downloadedVsix --force
code --list-extensions --show-versions
```

Expected: 公開前と再取得後のSHAが一致し、`local.novel-ai-assistant@0.0.2`が表示される。
