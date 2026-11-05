import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { window, workspace } from "../support/vscodeStub";
import type { WorkEntry } from "../../../src/models/types";

/** 作品の送り先（git remote get-url origin）の偽物。テストごとに差し替える */
const gitState = { origin: "https://github.com/author/tayutau.git" };
vi.mock("../../../src/core/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/git")>();
  return {
    ...actual,
    isGitAvailable: async () => true,
    runGit: async (args: readonly string[]) =>
      args[0] === "remote" ? { code: 0, stdout: `${gitState.origin}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" },
  };
});

/**
 * 編集者として参加する：作品の数では止めない（作者の指示 2026-11-05 夜「複数の作品に参加できる」。
 * 設計書5.6.6）。以前は「作品は1つまで」で、2作品目のリンクを貼ると「登録を外して」と出た。
 *
 * 同じ作品のリンクを貼り直したときだけ、取り寄せる前に止めて受け取りへ案内する（0.127.6）。
 */

const { joinAsEditor, RECEIVE_STEP_LABEL } = await import("../../../src/features/joinAsEditor");
const { EDITOR_STEP_DEFS } = await import("../../../src/core/stepDefs");

const works: WorkEntry[] = [
  { id: "a", title: "作品A", folderPath: "C:\\Novels\\A", registeredAt: "2026-10-28T00:00:00.000Z" },
];

describe("編集者として参加：作品の数", () => {
  const warnings: string[] = [];
  const asked = vi.fn();

  beforeEach(() => {
    warnings.length = 0;
    asked.mockReset();
    Object.assign(window, {
      showWarningMessage: vi.fn(async (text: string) => {
        warnings.push(text);
        return undefined;
      }),
      showInformationMessage: vi.fn(async () => undefined),
      showInputBox: asked,
    });
  });
  afterEach(() => {
    Object.assign(window, { showInputBox: undefined });
  });

  /*
    作者モードの環境に作品があれば止める（作者の答え 2026-11-05 夜「作品があれば止める」）。
    参加すると環境ごと編集者モードになり、作者自身の作品まで編集者モードで開くことになる
  */
  test("作者モードで作品が登録済みなら、リンクを訊く前に理由を出して止まる", async () => {
    await joinAsEditor({ list: () => works } as never);

    expect(asked).not.toHaveBeenCalled();
    const text = warnings.join("\n");
    expect(text).toContain("このままでは参加できません");
    expect(text).toContain("1 件の作品が登録されている");
    expect(text).not.toContain("つまで");
  });

  test("作者モードで作品が0件なら、止めずにリンクを訊く", async () => {
    await joinAsEditor({ list: () => [] } as never);

    expect(asked).toHaveBeenCalled();
    expect(warnings.join("\n")).not.toContain("このままでは参加できません");
  });
});

describe("編集者として参加：編集者モードで、もう作品に参加しているとき（作者の答え 2026-11-05）", () => {
  const warnings: string[] = [];
  const infos: string[] = [];
  const originalConfiguration = workspace.getConfiguration;
  const joined: WorkEntry[] = [
    { id: "s", title: "砂の塔", folderPath: "C:\\Novels\\編集部\\suna", registeredAt: "2026-10-01T00:00:00.000Z" },
    { id: "t", title: "たゆたう鉛", folderPath: "C:\\Novels\\編集部\\tayutau", registeredAt: "2026-11-01T00:00:00.000Z" },
  ];

  beforeEach(() => {
    warnings.length = 0;
    infos.length = 0;
    gitState.origin = "https://github.com/author/tayutau.git";
    workspace.getConfiguration = ((section?: string) =>
      section === "novelai"
        ? { get: (key: string, fallback: unknown) => (key === "mode" ? "editor" : fallback) }
        : originalConfiguration()) as typeof workspace.getConfiguration;
    Object.assign(window, {
      showWarningMessage: vi.fn(async (text: string) => {
        warnings.push(text);
        return undefined;
      }),
      showInformationMessage: vi.fn(async (text: string) => {
        infos.push(text);
        return undefined;
      }),
    });
  });
  afterEach(() => {
    workspace.getConfiguration = originalConfiguration;
    Object.assign(window, { showInputBox: undefined });
  });

  test("同じ作品のリンクなら「もう参加している」と言い、編集者メニューの受け取りの手順を指す", async () => {
    Object.assign(window, { showInputBox: vi.fn(async () => "https://github.com/author/tayutau") });
    const result = await joinAsEditor({ list: () => joined } as never);

    expect(infos.join("\n")).toContain("には、もう編集者として参加しています");
    expect(infos.join("\n")).toContain(`「${RECEIVE_STEP_LABEL}」`);
    expect(warnings.join("\n")).not.toContain("登録を外して");
    // 参加済みの作品を返す（編集者メニューがその作品を選ぶ）
    expect(result?.kind).toBe("already");
  });

  test("案内で指す手順の名前は、編集者メニューの手順1と同じ", () => {
    expect(EDITOR_STEP_DEFS[0].label).toBe(RECEIVE_STEP_LABEL);
  });

  test("別の作品のリンクなら、登録を外せとは言わず、参加へ進む（作品が増える）", async () => {
    gitState.origin = "https://github.com/author/other.git";
    const ask = vi.fn(async () => "https://github.com/author/another");
    Object.assign(window, { showInputBox: ask });
    await joinAsEditor({ list: () => joined } as never);

    expect(warnings.join("\n")).not.toContain("登録を外して");
    expect(infos.join("\n")).not.toContain("もう編集者として参加しています");
  });
});
