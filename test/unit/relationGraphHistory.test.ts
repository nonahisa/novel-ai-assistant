import { describe, expect, test } from "vitest";
import {
  EMPTY_CENTER_HISTORY,
  pushCenterHistory,
  stepCenterHistory,
} from "../../src/features/relationGraphPanel";

/**
 * 人物相関図の「戻る」「進む」（設計書6.38.3）。
 *
 * 進むはマウスの進むボタンからも来る（作者の依頼、2026-09-10）。
 * **押せるかどうかの表示（canGoBack／canGoForward）も、この履歴から作る**
 * ので、積み方が狂うと押せない・押しても動かないボタンが出る。
 */

/** アリシア → ベルン → カイ と辿った状態 */
function walked() {
  let history = EMPTY_CENTER_HISTORY;
  history = pushCenterHistory(history, null, "アリシア");
  history = pushCenterHistory(history, "アリシア", "ベルン");
  history = pushCenterHistory(history, "ベルン", "カイ");
  return history;
}

describe("中心を切り替えたとき", () => {
  test("いまの中心を戻る側へ積む", () => {
    expect(walked()).toEqual({ back: ["アリシア", "ベルン"], forward: [] });
  });

  test("中心がまだ無ければ、何も積まない", () => {
    expect(pushCenterHistory(EMPTY_CENTER_HISTORY, null, "アリシア")).toEqual(
      EMPTY_CENTER_HISTORY
    );
  });

  test("同じ人物を押し直しても積まない（押しても動かない回を作らない）", () => {
    const history = walked();
    expect(pushCenterHistory(history, "カイ", "カイ")).toEqual(history);
  });

  test("戻ったあとに別の人物を押すと、進む先は捨てる", () => {
    const back = stepCenterHistory(walked(), "カイ", "back")!;
    expect(back.history.forward).toEqual(["カイ"]);

    const branched = pushCenterHistory(back.history, back.center, "ディー");
    expect(branched).toEqual({ back: ["アリシア", "ベルン"], forward: [] });
  });
});

describe("戻る・進む", () => {
  test("戻ると、直前の中心へ移り、いまの中心は進む側へ積まれる", () => {
    const step = stepCenterHistory(walked(), "カイ", "back");
    expect(step).toEqual({
      center: "ベルン",
      history: { back: ["アリシア"], forward: ["カイ"] },
    });
  });

  test("進むと、戻ったぶんだけ元へ戻る（往復して元の形に戻る）", () => {
    const start = walked();
    const back = stepCenterHistory(start, "カイ", "back")!;
    const forward = stepCenterHistory(back.history, back.center, "forward");

    expect(forward).toEqual({ center: "カイ", history: start });
  });

  test("行き先が無ければ null（何もしない）", () => {
    expect(stepCenterHistory(walked(), "カイ", "forward")).toBeNull();
    expect(
      stepCenterHistory(EMPTY_CENTER_HISTORY, "アリシア", "back")
    ).toBeNull();
  });

  test("中心が決まっていなければ、反対側へは積まない", () => {
    const step = stepCenterHistory(
      { back: ["アリシア"], forward: [] },
      null,
      "back"
    );
    expect(step).toEqual({
      center: "アリシア",
      history: { back: [], forward: [] },
    });
  });

  test("元の履歴を書き換えない（画面へ送る前と後で食い違わせない）", () => {
    const history = walked();
    stepCenterHistory(history, "カイ", "back");
    expect(history).toEqual({ back: ["アリシア", "ベルン"], forward: [] });
  });
});
