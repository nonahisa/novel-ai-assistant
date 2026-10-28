import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { window } from "../support/vscodeStub";
import type { WorkEntry } from "../../../src/models/types";

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
