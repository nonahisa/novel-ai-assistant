import { describe, expect, test } from "vitest";
import {
  applyEpisodePlotRenames,
  chapterAtManuscriptLine,
  episodePlotOrder,
  EPISODE_PLOT_MOVING_PREFIX,
  neighborEpisodeChapter,
  planPlannedEpisodeInsert,
  planPlannedEpisodeStep,
  type EpisodePlotRename,
} from "../../../src/core/episodePlotOrder";
import { episodePlotFileName } from "../../../src/core/resumeSheet";

/**
 * 単話プロットの並び（設計書6.36・6.4.8。作者の依頼、2026-09-23
 * 「プロットモードと単話プロットをうまくつないでくださいね」）。
 *
 * - 前後の単話プロットへ移る：書いた話と予定の話を合わせた話数順
 * - 予定の話の並べ替え・差し込み：**動かすのは予定の話の単話プロットの
 *   名前（話数）だけ。本文のファイルには一切触れない。** 本文のある話の
 *   話数を変えることになるなら、理由を出して止める
 */

/** 書いた話（本文のファイル）。合本は範囲で渡す */
function written(...chapters: Array<number | [number, number]>) {
  return chapters.map((entry) =>
    Array.isArray(entry)
      ? { chapterStart: entry[0], chapterEnd: entry[1] }
      : { chapterStart: entry, chapterEnd: null }
  );
}

describe("書いた話と予定の話を合わせた並び", () => {
  test("話数順に並べ、予定の話に印を付ける", () => {
    const order = episodePlotOrder(written(1, 2, 3), [2, 5, 4]);
    expect(order).toEqual([
      { chapter: 1, planned: false },
      { chapter: 2, planned: false },
      { chapter: 3, planned: false },
      { chapter: 4, planned: true },
      { chapter: 5, planned: true },
    ]);
  });

  test("合本は中の話を1つずつ並べる", () => {
    const order = episodePlotOrder(written([1, 3]), [5]);
    expect(order.map((entry) => entry.chapter)).toEqual([1, 2, 3, 5]);
  });

  test("話数の読めない話は並べない", () => {
    const order = episodePlotOrder([{ chapterStart: null }], [2]);
    expect(order).toEqual([{ chapter: 2, planned: true }]);
  });
});

describe("前後の話", () => {
  const order = episodePlotOrder(written(1, 2, 3), [5]);

  test("次・前を話数順で返す（予定の話も含む）", () => {
    expect(neighborEpisodeChapter(order, 3, "next")).toBe(5);
    expect(neighborEpisodeChapter(order, 5, "prev")).toBe(3);
  });

  test("端では null", () => {
    expect(neighborEpisodeChapter(order, 1, "prev")).toBeNull();
    expect(neighborEpisodeChapter(order, 5, "next")).toBeNull();
  });

  test("並びに無い話数（飛んだ番号）からは、いちばん近い前後へ", () => {
    expect(neighborEpisodeChapter(order, 4, "next")).toBe(5);
    expect(neighborEpisodeChapter(order, 4, "prev")).toBe(3);
  });
});

describe("予定の話を1つ上・下へ動かす", () => {
  test("隣が予定の話なら、話数を入れ替える", () => {
    const plan = planPlannedEpisodeStep(written(1, 2), [3, 4], 4, "up");
    expect(plan).toEqual({
      kind: "move",
      renames: [
        { from: 4, to: 3 },
        { from: 3, to: 4 },
      ],
    });
  });

  test("下へも同じ", () => {
    const plan = planPlannedEpisodeStep(written(1, 2), [3, 4], 3, "down");
    expect(plan.kind).toBe("move");
    if (plan.kind !== "move") return;
    expect(plan.renames).toEqual([
      { from: 3, to: 4 },
      { from: 4, to: 3 },
    ]);
  });

  test("隣が本文のある話で、間に空きが無ければ止める（本文の話数の振り直しになる）", () => {
    const plan = planPlannedEpisodeStep(written(1, 2), [3], 3, "up");
    expect(plan.kind).toBe("blocked");
    if (plan.kind !== "blocked") return;
    expect(plan.reason).toContain("本文");
    expect(plan.reason).toContain("振り直し");
  });

  test("本文のある話の手前に空いた話数があれば、そこへ移すだけで越えられる", () => {
    // 1・3 が本文、2 は空き、5 が予定。5 を上へ → 2 へ（本文は動かない）
    const plan = planPlannedEpisodeStep(written(1, 3), [5], 5, "up");
    expect(plan).toEqual({ kind: "move", renames: [{ from: 5, to: 2 }] });
  });

  test("本文のある話の後ろへ下げるときも、空いた話数へ移す", () => {
    // 2 が予定、3 が本文、4 は空き
    const plan = planPlannedEpisodeStep(written(1, 3), [2], 2, "down");
    expect(plan).toEqual({ kind: "move", renames: [{ from: 2, to: 4 }] });
  });

  test("端では動かさない", () => {
    expect(planPlannedEpisodeStep(written(), [1, 2], 1, "up").kind).toBe("noop");
    expect(planPlannedEpisodeStep(written(), [1, 2], 2, "down").kind).toBe("noop");
  });

  test("本文のある話は動かさない（予定の話ではない）", () => {
    const plan = planPlannedEpisodeStep(written(1, 2), [2, 3], 2, "down");
    expect(plan.kind).toBe("blocked");
  });
});

describe("予定の話を指定の話数へ差し込む", () => {
  test("空いた話数なら、名前を変えるだけ", () => {
    const plan = planPlannedEpisodeInsert(written(1, 2), [9], 9, 4);
    expect(plan).toEqual({ kind: "move", renames: [{ from: 9, to: 4 }] });
  });

  test("予定の話がいる話数なら、後ろの予定を1つずつずらす（前へ動かすとき）", () => {
    // 3・4・5 が予定。5 を 3 へ → 3→4、4→5、5→3
    const plan = planPlannedEpisodeInsert(written(1, 2), [3, 4, 5], 5, 3);
    expect(plan.kind).toBe("move");
    if (plan.kind !== "move") return;
    expect(new Set(plan.renames.map((entry) => `${entry.from}->${entry.to}`))).toEqual(
      new Set(["5->3", "3->4", "4->5"])
    );
  });

  test("ずらす途中に空きがあれば、そこで止まる", () => {
    // 3・4・7 が予定。7 を 3 へ → 3→4、4→5（5 は空き）、7→3
    const plan = planPlannedEpisodeInsert(written(1, 2), [3, 4, 7], 7, 3);
    expect(plan.kind).toBe("move");
    if (plan.kind !== "move") return;
    expect(new Set(plan.renames.map((entry) => `${entry.from}->${entry.to}`))).toEqual(
      new Set(["7->3", "3->4", "4->5"])
    );
  });

  test("後ろへ動かすときは、前の予定を1つずつ詰める", () => {
    // 3・4・5 が予定。3 を 5 へ → 4→3、5→4、3→5
    const plan = planPlannedEpisodeInsert(written(1, 2), [3, 4, 5], 3, 5);
    expect(plan.kind).toBe("move");
    if (plan.kind !== "move") return;
    expect(new Set(plan.renames.map((entry) => `${entry.from}->${entry.to}`))).toEqual(
      new Set(["3->5", "4->3", "5->4"])
    );
  });

  test("本文のある話数へは差し込まない（本文の話数の振り直しになる）", () => {
    const plan = planPlannedEpisodeInsert(written(1, 2, 3), [5], 5, 2);
    expect(plan.kind).toBe("blocked");
    if (plan.kind !== "blocked") return;
    expect(plan.reason).toContain("第2話は本文があります");
  });

  test("ずらす先に本文のある話があれば止める（本文のある話と話の間への差し込み）", () => {
    // 3 が予定、4 が本文。7 を 3 へ差し込むと、3 を 4 へずらすことになる
    const plan = planPlannedEpisodeInsert(written(1, 2, 4), [3, 7], 7, 3);
    expect(plan.kind).toBe("blocked");
    if (plan.kind !== "blocked") return;
    expect(plan.reason).toContain("本文");
  });

  test("合本の範囲の中へも差し込まない", () => {
    const plan = planPlannedEpisodeInsert(written([1, 10]), [12], 12, 5);
    expect(plan.kind).toBe("blocked");
  });

  test("同じ話数・0以下は動かさない", () => {
    expect(planPlannedEpisodeInsert(written(), [3], 3, 3).kind).toBe("noop");
    expect(planPlannedEpisodeInsert(written(), [3], 3, 0).kind).toBe("blocked");
  });
});

/** 置き場の作り物。名前→中身の印だけを持つ */
function fakeFolder(names: string[]) {
  const files = new Map<string, string>(names.map((name) => [name, name]));
  const log: string[] = [];
  let failOn: ((from: string, to: string) => boolean) | undefined;
  return {
    files,
    log,
    failWhen(predicate: (from: string, to: string) => boolean) {
      failOn = predicate;
    },
    ops: {
      async rename(from: string, to: string): Promise<void> {
        if (failOn?.(from, to)) throw new Error(`名前を変えられません：${from}`);
        if (!files.has(from)) throw new Error(`${from} がありません`);
        // **上書きしない**（本物も overwrite: false で呼ぶ）
        if (files.has(to)) throw new Error(`${to} が既にあります`);
        files.set(to, files.get(from)!);
        files.delete(from);
        log.push(`${from}->${to}`);
      },
    },
  };
}

describe("名前の付け替えを実行する", () => {
  const swap: EpisodePlotRename[] = [
    { from: 3, to: 4 },
    { from: 4, to: 3 },
  ];

  test("入れ替えは一時名を通すので、ぶつからない", async () => {
    const folder = fakeFolder([episodePlotFileName(3), episodePlotFileName(4)]);
    const outcome = await applyEpisodePlotRenames(swap, folder.ops);
    expect(outcome.ok).toBe(true);
    // 中身（元の名前の印）が入れ替わっている
    expect(folder.files.get(episodePlotFileName(4))).toBe(episodePlotFileName(3));
    expect(folder.files.get(episodePlotFileName(3))).toBe(episodePlotFileName(4));
    // 一時名は残らない
    expect([...folder.files.keys()].some((name) => name.startsWith(EPISODE_PLOT_MOVING_PREFIX))).toBe(false);
  });

  test("途中で失敗したら、元の名前へ戻す", async () => {
    const folder = fakeFolder([episodePlotFileName(3), episodePlotFileName(4)]);
    // 2段目（一時名→新しい名前）の2件目で、1度だけ失敗させる（戻す手は通す）
    let failed = false;
    folder.failWhen((from, to) => {
      if (failed) return false;
      if (from.startsWith(EPISODE_PLOT_MOVING_PREFIX) && to === episodePlotFileName(3)) {
        failed = true;
        return true;
      }
      return false;
    });
    const outcome = await applyEpisodePlotRenames(swap, folder.ops);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rolledBack).toBe(true);
    expect(folder.files.get(episodePlotFileName(3))).toBe(episodePlotFileName(3));
    expect(folder.files.get(episodePlotFileName(4))).toBe(episodePlotFileName(4));
    expect(folder.files.size).toBe(2);
  });

  test("戻すのにも失敗したら、どこに何が残ったかを返す", async () => {
    const folder = fakeFolder([episodePlotFileName(3), episodePlotFileName(4)]);
    // 一時名から先へは一切動かせない（戻すのも失敗する）
    folder.failWhen((from) => from.startsWith(EPISODE_PLOT_MOVING_PREFIX));
    const outcome = await applyEpisodePlotRenames(swap, folder.ops);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.stranded.length).toBeGreaterThan(0);
    for (const entry of outcome.stranded) {
      expect(folder.files.has(entry.now)).toBe(true);
      expect([episodePlotFileName(3), episodePlotFileName(4)]).toContain(entry.original);
    }
  });

  test("最初の一歩で失敗したら、何も動いていない", async () => {
    const folder = fakeFolder([episodePlotFileName(3), episodePlotFileName(4)]);
    folder.failWhen(() => true);
    const outcome = await applyEpisodePlotRenames(swap, folder.ops);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rolledBack).toBe(true);
    expect(folder.log).toEqual([]);
  });
});

describe("原稿のその行は何話か", () => {
  const collected = [
    "------------------------- エピソード1開始 -------------------------",
    "【エピソードタイトル】",
    "１話　はじまり",
    "",
    "【本文】",
    "本文1",
    "------------------------- エピソード2開始 -------------------------",
    "【エピソードタイトル】",
    "２話　つづき",
    "",
    "【本文】",
    "本文2",
  ].join("\n");

  test("合本ならカーソルの行の話", () => {
    expect(chapterAtManuscriptLine(collected, 6)).toBe(1);
    expect(chapterAtManuscriptLine(collected, 12)).toBe(2);
  });

  test("合本でなければ undefined（ファイル名で決める）", () => {
    expect(chapterAtManuscriptLine("ただの本文", 1)).toBeUndefined();
  });
});
