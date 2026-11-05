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
 * 編集部として参加する：作品は1つまでの仕切り（レビュー指摘 B4、2026-10-28）。
 *
 * 作者モードから参加すると「登録してから編集者モードへ切り替える」ので、先に数えないと
 * 作品が複数のまま編集者モードになる。**取り寄せる前に**止める。
 */

const { joinAsEditor } = await import("../../../src/features/joinAsEditor");

const works: WorkEntry[] = [
  { id: "a", title: "作品A", folderPath: "C:\\Novels\\A", registeredAt: "2026-10-28T00:00:00.000Z" },
];

describe("編集部として参加：作品の数", () => {
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

  test("作者モードで作品が登録済みなら、リンクを訊く前に理由を出して止まる", async () => {
    await joinAsEditor({ list: () => works } as never);

    expect(asked).not.toHaveBeenCalled();
    expect(warnings.join("\n")).toContain("このままでは参加できません");
    expect(warnings.join("\n")).toContain("1 件の作品が登録されている");
  });
});

describe("編集部として参加：編集者モードで、もう作品に参加しているとき（作者の答え 2026-11-05）", () => {
  const warnings: string[] = [];
  const infos: string[] = [];
  const originalConfiguration = workspace.getConfiguration;
  const joined: WorkEntry[] = [
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

  test("同じ作品のリンクなら「もう参加している・保存・同期で受け取る」と案内し、登録を外せとは言わない", async () => {
    Object.assign(window, { showInputBox: vi.fn(async () => "https://github.com/author/tayutau") });
    await joinAsEditor({ list: () => joined } as never);

    expect(infos.join("\n")).toContain("「たゆたう鉛」には、もう編集者として参加しています");
    expect(infos.join("\n")).toContain("「保存・同期」");
    expect(warnings.join("\n")).not.toContain("登録を外して");
  });

  test("別の作品のリンクなら、登録を外すよう案内する", async () => {
    Object.assign(window, { showInputBox: vi.fn(async () => "https://github.com/author/another") });
    await joinAsEditor({ list: () => joined } as never);

    expect(warnings.join("\n")).toContain("先に「たゆたう鉛」の登録を外してください");
    expect(warnings.join("\n")).toContain("author/another");
    expect(infos.join("\n")).not.toContain("もう編集者として参加しています");
  });
});
