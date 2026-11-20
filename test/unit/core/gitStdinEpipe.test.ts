import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { runGit } from "../../../src/core/git";

/**
 * git が標準入力を読み終える前に終わると、書き込みの側に EPIPE が出る。
 * 拾わないと、捕まえていない例外として拡張機能ホストまで上がる
 * （2026-11-21、Mac の全件の流しで editingGitRecovery・gitLargeFiles の途中に2件出た）。
 *
 * `git --version` は標準入力を読まずにすぐ終わるので、大きな入力を渡すと
 * 書き込みが間に合わず、ほぼ必ず EPIPE になる。
 */
describe("git の標準入力", () => {
  test("git が先に終わっても、捕まえていない例外にならず結果を返す", async () => {
    const big = "x".repeat(32 * 1024 * 1024);
    const result = await runGit(["--version"], tmpdir(), 20_000, { input: big });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^git version/);
    // 書き込みの失敗が後から届く分も待つ
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
});
