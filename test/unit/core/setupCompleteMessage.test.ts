import { describe, expect, test } from "vitest";
import {
  buildSetupPlan,
  describeSetupPlan,
  REQUIREMENTS,
  setupCompleteMessage,
  type RequirementId,
  type RequirementState,
} from "../../../src/core/requirements";
import { ghState, type CommandRunner } from "../../../src/core/gitSetup";

/**
 * セットアップで入れたあとに確かめ直したときの知らせ（2026-11-07 Mac の実機確認で見つかった）。
 *
 * 任意のもの（bge-m3、認証前の gh）がまだ足りないのに「必要なものはすべて揃っています。」と出て、
 * 全部揃ったと読み違えやすかった。gh は入れたあとも、認証の前は「GitHub CLI を入れる」が残っていた。
 */
function states(
  overrides: Partial<Record<RequirementId, boolean>>,
  extra: Partial<Record<RequirementId, Partial<RequirementState>>> = {}
): RequirementState[] {
  return REQUIREMENTS.map((requirement) => ({
    id: requirement.id,
    present: overrides[requirement.id] ?? false,
    ...extra[requirement.id],
  }));
}

describe("揃ったときの知らせ", () => {
  test("任意も含めて全部あれば「すべて揃っています」", () => {
    const plan = buildSetupPlan(
      states({ ollama: true, chatModel: true, embeddingModel: true, git: true, gh: true })
    );
    expect(setupCompleteMessage(plan)).toBe("必要なものはすべて揃っています。");
  });

  test("任意が残っていれば、必須だけ揃ったことと残りの件数・名前を言う", () => {
    const plan = buildSetupPlan(states({ ollama: true, chatModel: true, git: true, gh: true }));
    const message = setupCompleteMessage(plan);
    expect(message).not.toContain("すべて揃っています");
    expect(message).toContain("必須のものはすべて揃いました");
    expect(message).toContain("1件");
    const embedding = REQUIREMENTS.find((r) => r.id === "embeddingModel")!;
    expect(message).toContain(embedding.label);
    expect(message).toContain("あとからでも");
  });
});

describe("GitHub CLI が入っているが、ログインがまだ", () => {
  const plan = buildSetupPlan(
    states(
      { ollama: true, chatModel: true, embeddingModel: true, git: true, gh: false },
      { gh: { needsLogin: true } }
    )
  );

  test("「入れる」の側に並べず、ログイン待ちとして分ける", () => {
    expect(plan.missingOptional.map((e) => e.requirement.id)).not.toContain("gh");
    expect(plan.needsLogin.map((e) => e.requirement.id)).toEqual(["gh"]);
    expect(plan.complete).toBe(false);
  });

  test("知らせでは、ログインがまだと言う", () => {
    const message = setupCompleteMessage(plan);
    expect(message).toContain("必須のものはすべて揃いました");
    expect(message).toContain("GitHub CLI（ログインがまだ）");
  });

  test("一覧でも「入れない場合」でなく、ログインがまだと書く", () => {
    const text = describeSetupPlan(plan);
    expect(text).toContain("ログインがまだ");
    expect(text).not.toContain("入れない場合：GitHub");
  });
});

describe("gh の状態の見分け", () => {
  const runner =
    (versionCode: number, authCode: number): CommandRunner =>
    async (_command, args) => ({
      code: args[0] === "--version" ? versionCode : authCode,
      stdout: "",
      stderr: "",
    });

  test("入っていない", async () => {
    expect(await ghState(runner(1, 0))).toBe("missing");
  });
  test("入っているがログインがまだ", async () => {
    expect(await ghState(runner(0, 1))).toBe("needsLogin");
  });
  test("使える", async () => {
    expect(await ghState(runner(0, 0))).toBe("ready");
  });
});
