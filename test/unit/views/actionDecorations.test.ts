import { describe, expect, test, vi } from "vitest";
import { ActionDecorationProvider } from "../../../src/views/actionDecorations";
import type { ActionCounter } from "../../../src/views/actionList";

/**
 * メニューの印を、作品ごとに数えて覚える（docs/measurements/2026-10-29-非AIの速さ.md）。
 *
 * 簡単ステップメニューで作品を選び直すだけで、全作品の資料を読み直して
 * 印（未反映・辞書・重複の候補）を数えていた（写しで1回93ms・ファイル431回）。
 * 作品ごとの件数を覚え、合計（詳細メニュー用）はその和にする。
 */

/** 作品ごとの件数。どの作品をいくつ数えたかを `load` の呼び出しで見る */
const COUNTS: Record<string, number> = { wA: 2, wB: 24, wC: 5 };

function setup(works: string[] = ["wA", "wB", "wC"]) {
  const load = vi.fn(async (_counter: ActionCounter, workId?: string) => {
    if (workId === undefined) throw new Error("作品を渡さずに数えてはいけない");
    return COUNTS[workId] ?? 0;
  });
  const listed = [...works];
  const provider = new ActionDecorationProvider(load, () => listed);
  const loadedWorks = (): string[] => [
    ...new Set(load.mock.calls.map((call) => call[1] as string)),
  ];
  return { load, provider, listed, loadedWorks };
}

describe("メニューの印を作品ごとに覚える", () => {
  test("全部数えると、合計は作品ごとの件数の和になる", async () => {
    const { provider, loadedWorks } = setup();

    await provider.refresh();

    expect(loadedWorks().sort()).toEqual(["wA", "wB", "wC"]);
    expect(provider.countOf("mergeCandidates")).toBe(2 + 24 + 5);
    expect(provider.countOfWork("wB", "mergeCandidates")).toBe(24);
  });

  test("1作品の数え直しでは、ほかの作品を読まない", async () => {
    const { load, provider, loadedWorks } = setup();
    await provider.refresh();
    load.mockClear();

    COUNTS.wA = 7;
    await provider.refresh("wA");

    expect(loadedWorks()).toEqual(["wA"]);
    // 合計は、覚えていたほかの作品の数との和
    expect(provider.countOf("mergeCandidates")).toBe(7 + 24 + 5);
    COUNTS.wA = 2;
  });

  test("数えた作品を選び直しても、数え直さなくてよいと分かる", async () => {
    const { provider } = setup();
    expect(provider.hasCounted("wA")).toBe(false);

    await provider.refresh();

    expect(provider.hasCounted("wA")).toBe(true);
    expect(provider.hasCounted("wB")).toBe(true);
    expect(provider.hasCounted(undefined)).toBe(true);
  });

  test("まだ数えていない作品があれば、1作品の頼みでも全部数える", async () => {
    // 起動直後の数えが済む前に作品を選び直した、など。合計が欠けないように
    const { provider, loadedWorks } = setup();

    await provider.refresh("wA");

    expect(loadedWorks().sort()).toEqual(["wA", "wB", "wC"]);
    expect(provider.countOf("mergeCandidates")).toBe(31);
  });

  test("登録から外れた作品は、合計から抜ける", async () => {
    const { provider, listed } = setup();
    await provider.refresh();

    listed.splice(listed.indexOf("wB"), 1);
    await provider.refresh();

    expect(provider.countOf("mergeCandidates")).toBe(2 + 5);
  });

  test("同じ作品を続けて数え直したら、後から始めた数が残る", async () => {
    const { load, provider } = setup(["wA"]);
    await provider.refresh();

    // 1回目の数え直しは遅く、2回目より後に返ってくる
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    load.mockImplementationOnce(async () => {
      await slow;
      return 100;
    });
    const older = provider.refresh("wA");
    COUNTS.wA = 9;
    const newer = provider.refresh("wA");
    await newer;
    release();
    await older;

    // 遅れて返った古い数（100）が、どの種類にも残っていない
    for (const counter of ["pendingUpdates", "staleImeDictionary", "mergeCandidates"] as const) {
      expect(provider.countOfWork("wA", counter), counter).toBe(9);
    }
    COUNTS.wA = 2;
  });
});
