import { beforeEach, describe, expect, test, vi } from "vitest";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 誤字脱字は、**誤字脱字の札で**範囲を決める（設計書6.8.7）。
 *
 * 範囲の決め方そのものは機能に依らないので、共通の口
 * （`features/typoCheckScope.ts` の `resolveCheckScope`）へ寄せた。
 * ここで見るのは**その口へ何を渡しているか**である——渡す札を間違えると、
 * **誤字脱字を走らせた時刻で矛盾検知が絞られる**（作者の指摘、2026-09-20）。
 *
 * まとめ実行で聞かないこと・ログへ残すことは、口そのものの試験
 * （`checkScopeFeatures.test.ts`）で見る。
 */

const mocks = vi.hoisted(() => ({ resolveCheckScope: vi.fn() }));
vi.mock("../../../src/features/typoCheckScope", () => ({
  resolveCheckScope: mocks.resolveCheckScope,
}));

const { resolveTypoScope } = await import("../../../src/features/checkTypos");

const work: WorkEntry = {
  id: "w1",
  title: "試しの作品",
  folderPath: "C:/works/試しの作品",
  registeredAt: "2026-09-05T00:00:00.000Z",
};

beforeEach(() => {
  mocks.resolveCheckScope.mockReset();
  mocks.resolveCheckScope.mockResolvedValue({
    kind: "changed",
    filePaths: ["C:/works/試しの作品/原稿/02.txt"],
  });
});

describe("誤字脱字の対象範囲", () => {
  test("**誤字脱字の札**で共通の口を呼ぶ", () => {
    // ここが別の札になると、ほかの検知の「前回」で絞ってしまう
    return resolveTypoScope(work, {}).then(() => {
      expect(mocks.resolveCheckScope).toHaveBeenCalledWith(work, "typo", {});
    });
  });

  test("まとめ実行の印は、そのまま渡す", async () => {
    await resolveTypoScope(work, { suiteConfirmed: true });

    expect(mocks.resolveCheckScope).toHaveBeenCalledWith(work, "typo", {
      suiteConfirmed: true,
    });
  });

  test("印を渡さずに呼んでも通る（既定は単独実行）", async () => {
    await resolveTypoScope(work);

    expect(mocks.resolveCheckScope).toHaveBeenCalledTimes(1);
  });

  test("選んだ範囲は、そのまま返す", async () => {
    expect(await resolveTypoScope(work, {})).toEqual({
      kind: "changed",
      filePaths: ["C:/works/試しの作品/原稿/02.txt"],
    });
  });

  test("取りやめたら、取りやめのまま返す", async () => {
    // ここで `{ kind: "all" }` へ丸めると、Escで閉じたのに検知が走り出す
    mocks.resolveCheckScope.mockResolvedValue(undefined);

    expect(await resolveTypoScope(work, {})).toBeUndefined();
  });
});
