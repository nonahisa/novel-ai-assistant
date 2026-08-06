# Sakura AI Engine Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manually triggered GitHub Actions smoke test that securely verifies `gemma-4-31B-it` through Sakura AI Engine's OpenAI-compatible API.

**Architecture:** A dependency-free Node module owns the HTTP request and response validation so it can be unit-tested without network access. A minimal-permission workflow injects the existing repository secret and invokes the module only through `workflow_dispatch`; static tests lock down the workflow's trigger and security properties.

**Tech Stack:** Node.js 22 built-in `fetch`, Vitest 4, GitHub Actions, GitHub CLI, Sakura AI Engine OpenAI-compatible API.

## Global Constraints

- The endpoint is exactly `https://api.ai.sakura.ad.jp/v1/chat/completions`.
- The model is exactly `gemma-4-31B-it` with `stream: false` and `max_tokens: 32`.
- The only credential source is `SAKURA_AI_ACCOUNT_TOKEN`; never log the token, Authorization header, prompt response body, or local `.env` contents.
- The workflow trigger is only `workflow_dispatch`, with `contents: read` and `timeout-minutes: 5`.
- No npm runtime dependency is added for the smoke client.
- Local commits, pushing `feature/works`, and opening a draft PR to `main` are authorized; do not merge the PR.

---

### Task 1: Testable Sakura API smoke client

**Files:**
- Create: `scripts/sakuraAiSmoke.mjs`
- Create: `test/unit/sakuraAiSmoke.test.ts`

**Interfaces:**
- Consumes: `SAKURA_AI_ACCOUNT_TOKEN`, injected `fetchImpl`, optional `log` callback.
- Produces: `runSakuraAiSmoke({ token, fetchImpl, log }): Promise<{ model: string; contentLength: number }>` and a direct CLI entrypoint.

- [ ] **Step 1: Write failing behavior tests**

Create tests that inject a fake `fetchImpl` and verify: a 200 OpenAI-compatible response returns model and content length; the request uses Bearer authentication and the fixed model; a missing token fails before fetching; HTTP 401/429 failures reveal only the status; invalid JSON, absent model, and blank content fail; captured logs never contain the token or response content.

```ts
const result = await runSakuraAiSmoke({
  token: "uuid:secret",
  fetchImpl: async () => new Response(JSON.stringify({
    model: "gemma-4-31B-it",
    choices: [{ message: { content: "接続確認OK" } }],
  }), { status: 200, headers: { "content-type": "application/json" } }),
  log: (line) => logs.push(line),
});
expect(result).toEqual({ model: "gemma-4-31B-it", contentLength: 6 });
```

- [ ] **Step 2: Verify RED**

Run: `npm run test:unit -- test/unit/sakuraAiSmoke.test.ts`

Expected: FAIL because `scripts/sakuraAiSmoke.mjs` does not exist.

- [ ] **Step 3: Implement the minimal client and CLI**

Export endpoint/model constants and `runSakuraAiSmoke`. Send one Japanese user message, `temperature: 0`, `max_tokens: 32`, and `stream: false`. Validate the status and `choices[0].message.content`; log only `Sakura AI smoke test passed: model=<model>, contentLength=<number>`. The CLI passes `process.env.SAKURA_AI_ACCOUNT_TOKEN` and exits nonzero with only the sanitized error message.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:unit -- test/unit/sakuraAiSmoke.test.ts && npm run typecheck`

Expected: all focused tests pass and TypeScript type checking exits 0.

### Task 2: Manual-only GitHub Actions workflow

**Files:**
- Create: `.github/workflows/sakura-ai-smoke.yml`
- Create: `test/unit/sakuraWorkflow.test.ts`

**Interfaces:**
- Consumes: repository secret `${{ secrets.SAKURA_AI_ACCOUNT_TOKEN }}` and `scripts/sakuraAiSmoke.mjs`.
- Produces: GitHub Actions workflow `Sakura AI Engine Smoke Test`.

- [ ] **Step 1: Write the failing static workflow test**

Read the workflow as text and assert it contains `workflow_dispatch`, `contents: read`, `timeout-minutes: 5`, `SAKURA_AI_ACCOUNT_TOKEN: ${{ secrets.SAKURA_AI_ACCOUNT_TOKEN }}`, `node scripts/sakuraAiSmoke.mjs`, and no `push:`, `pull_request:`, or `schedule:` trigger.

- [ ] **Step 2: Verify RED**

Run: `npm run test:unit -- test/unit/sakuraWorkflow.test.ts`

Expected: FAIL because `.github/workflows/sakura-ai-smoke.yml` does not exist.

- [ ] **Step 3: Add the workflow**

Use `actions/checkout@v4` and `actions/setup-node@v4` with Node 22. Set workflow-level `permissions: { contents: read }`, job `timeout-minutes: 5`, and expose the secret only as the smoke step's environment variable. Do not echo or transform the secret in shell.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:unit -- test/unit/sakuraWorkflow.test.ts && npm run check:release`

Expected: static workflow test, all unit tests, typecheck, build, Extension Host tests, and dependency audit pass.

### Task 3: Documentation and distribution regression

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/進捗と引継ぎ.md`
- Modify: `.vscodeignore`
- Generate: `release/novel-ai-assistant-0.0.1.vsix`

**Interfaces:**
- Produces: operator instructions and a VSIX that excludes workflows, smoke scripts, tests, and credentials.

- [ ] **Step 1: Document setup and operation**

Document the repository secret name, Actions tab manual-run path, model, expected pass condition, rate-limit behavior, and the fact that the test is never automatic.

- [ ] **Step 2: Confirm packaging exclusions**

Ensure `.github/**`, `scripts/**`, `test/**`, `.env`, and `.env.*` are excluded by `.vscodeignore`; confirm `.env` remains ignored by Git.

- [ ] **Step 3: Rebuild and verify the VSIX**

Run: `npm run package:vsix && npm run verify:vsix && npm run test:ollama`

Expected: 8 allowlisted files, successful isolated install, zero forbidden strings/files, and a passing local Ollama live test.

### Task 4: Publish and execute on GitHub

**Files:**
- Publish the reviewed local changes on `feature/works` in a draft PR to `main`.

**Interfaces:**
- Consumes: a commit containing `.github/workflows/sakura-ai-smoke.yml` on the default branch and the registered `SAKURA_AI_ACCOUNT_TOKEN` secret.
- Produces: a successful GitHub Actions run URL and final evidence for the 0.0.1 release.

- [ ] **Step 1: Confirm publication scope**

Use the user-approved whole worktree scope. Do not stage `.env` or the ignored `release/` directory.

- [ ] **Step 2: Push and open the draft PR**

Commit the intended files, push `feature/works`, and open a draft PR to `main`; do not merge it. GitHub requires a `workflow_dispatch` workflow to exist on the default branch before it can be manually triggered.

- [ ] **Step 3: Record the default-branch execution gate**

Verify the draft PR contains the workflow and note that `gh workflow run sakura-ai-smoke.yml --ref main` becomes available only after merge. Use the local live Sakura API invocation as the pre-merge external-service evidence.

Expected: draft PR created, workflow visible in its diff, and no merge performed.

- [ ] **Step 4: Record final evidence**

Add the run URL, final VSIX SHA-256, local release-gate counts, and review verdict to `docs/進捗と引継ぎ.md`, then rerun `git diff --check` and `npm run verify:vsix`.
