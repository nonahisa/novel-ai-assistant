import { describe, expect, test } from "vitest";
import {
  describeLikelyWorkReason,
  isDetailMenuArgs,
  orderByLikelyWork,
  DETAIL_MENU_ARGS,
} from "../../../src/core/workTarget";

/**
 * 詳細メニューから押した、作品が要る命令は**毎回作品を選ばせる**
 * （作者の判断 2026-11-02。使いにくい所の洗い出し2回目の1）。
 *
 * ## なぜ訊くようにしたか
 *
 * 詳細メニューの項目は作品を持たないので、これまでは作品一覧の選択や
 * 相談の作品から推し量って走らせていた。作者から見ると「どの作品で走るのか」が
 * 押す前に分からない。訊く画面を出し、**いちばんありそうな作品を上に置く**
 * ——Enter だけで進めるので手間は増えず、違う作品ならその場で選び直せる。
 *
 * ## 並びの順（作者の指定）
 *
 * 書いている原稿の作品 → 作品一覧で選んでいる作品 → 簡単ステップメニューの
 * 選択作品 → 相談の作品。重なったら上の理由だけを出す。
 */

const works = [
  { id: "w-1" },
  { id: "w-2" },
  { id: "w-3" },
  { id: "w-4" },
  { id: "w-5" },
];

describe("作品を選ぶ画面の並び（詳細メニューから押したとき）", () => {
  test("原稿 → 作品一覧 → 簡単ステップ → 相談 の順で上へ出す", () => {
    const ordered = orderByLikelyWork(works, {
      manuscriptWorkId: "w-4",
      treeSelectedId: "w-2",
      stepSelectedId: "w-5",
      chatTargetId: "w-3",
    });
    expect(ordered.map((entry) => entry.work.id)).toEqual([
      "w-4",
      "w-2",
      "w-5",
      "w-3",
      "w-1",
    ]);
    expect(ordered.map((entry) => entry.reason)).toEqual([
      "manuscript",
      "tree",
      "step",
      "chat",
      undefined,
    ]);
  });

  test("重なった作品は1度だけ、上の理由で出す", () => {
    const ordered = orderByLikelyWork(works, {
      manuscriptWorkId: "w-3",
      treeSelectedId: "w-3",
      stepSelectedId: "w-1",
      chatTargetId: "w-1",
    });
    expect(ordered.map((entry) => entry.work.id)).toEqual([
      "w-3",
      "w-1",
      "w-2",
      "w-4",
      "w-5",
    ]);
    expect(ordered[0].reason).toBe("manuscript");
    expect(ordered[1].reason).toBe("step");
    expect(ordered.length).toBe(works.length);
  });

  test("手がかりが無ければ、並びはそのまま", () => {
    const ordered = orderByLikelyWork(works, {});
    expect(ordered.map((entry) => entry.work.id)).toEqual(
      works.map((work) => work.id)
    );
    expect(ordered.every((entry) => entry.reason === undefined)).toBe(true);
  });

  test("登録から外れた作品の手がかりは当てにしない", () => {
    const ordered = orderByLikelyWork(works, {
      manuscriptWorkId: "w-9",
      chatTargetId: "w-2",
    });
    expect(ordered.map((entry) => entry.work.id)).toEqual([
      "w-2",
      "w-1",
      "w-3",
      "w-4",
      "w-5",
    ]);
  });

  test("元の配列を書き換えない", () => {
    const original = [...works];
    orderByLikelyWork(works, { treeSelectedId: "w-5" });
    expect(works).toEqual(original);
  });

  test("上に置いた理由を、説明欄の言葉で返す", () => {
    expect(describeLikelyWorkReason("manuscript")).toBe("いま書いている原稿");
    expect(describeLikelyWorkReason("tree")).toBe("作品一覧で選んでいる作品");
    expect(describeLikelyWorkReason("step")).toBe(
      "簡単ステップメニューで選んでいる作品"
    );
    expect(describeLikelyWorkReason("chat")).toBe("相談している作品");
  });
});

describe("詳細メニューから押した印", () => {
  test("印を見分ける", () => {
    expect(isDetailMenuArgs(DETAIL_MENU_ARGS)).toBe(true);
    expect(isDetailMenuArgs({ source: "detailMenu" })).toBe(true);
    expect(isDetailMenuArgs(undefined)).toBe(false);
    expect(isDetailMenuArgs({ source: "manuscriptEditor" })).toBe(false);
    expect(isDetailMenuArgs({ type: "work", work: { id: "w-1" } })).toBe(false);
  });
});
