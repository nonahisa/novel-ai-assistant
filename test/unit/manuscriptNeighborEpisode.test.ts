import { describe, expect, it } from "vitest";
import { planNeighborStep } from "../../src/features/manuscriptEditor";

/**
 * 原稿エディタの「← 前の話」「次の話 →」（設計書6.25.5、実機確認リスト F-35）。
 *
 * **端に来たときに何が起きるか**を機械で見る。ボタンが画面に並ぶことと、
 * 実際に別の話が開くことは実機に残るが、「最初の話です。」と
 * 「最新話です。」が出る条件、そして**どこで新しい話を作るか**は、
 * 押した結果そのものなので、ここで固めておく。
 *
 * いちばん気をつけるのは**空の話を増やさないこと**である。最終話が白紙の
 * ときに作ると、「次の話 →」を押すたびに空のファイルが積み上がる。
 */

/** 19話ある作品の、n話目（0始まり）を開いている状態 */
function at(index: number, options: { blank?: boolean } = {}) {
  return {
    at: index,
    count: 19,
    currentIsBlank: options.blank ?? false,
  } as const;
}

describe("前の話へ", () => {
  it("後ろの話からは、1つ前を開く（実機確認リスト F-35 の代わり）", () => {
    expect(planNeighborStep({ ...at(5), direction: "prev" })).toEqual({
      kind: "open",
      index: 4,
    });
  });

  it("最初の話では「最初の話です。」と伝える（実機確認リスト F-35 の代わり）", () => {
    expect(planNeighborStep({ ...at(0), direction: "prev" })).toEqual({
      kind: "notice",
      message: "最初の話です。",
    });
  });

  it("最初の話が白紙でも、前へは作らない（実機確認リスト F-35 の代わり）", () => {
    // 前へ遡って話を作る道は無い（話数がずれる）
    expect(
      planNeighborStep({ ...at(0, { blank: true }), direction: "prev" })
    ).toEqual({ kind: "notice", message: "最初の話です。" });
  });
});

describe("次の話へ", () => {
  it("後ろに話があれば、それを開く（実機確認リスト F-35 の代わり）", () => {
    expect(planNeighborStep({ ...at(5), direction: "next" })).toEqual({
      kind: "open",
      index: 6,
    });
  });

  it("空白の最終話では「最新話です。」と伝えるだけ（実機確認リスト F-35 の代わり）", () => {
    // **押すたびに空のファイルが増えるのを避ける**（「最新話を書く」と同じ）
    expect(
      planNeighborStep({ ...at(18, { blank: true }), direction: "next" })
    ).toEqual({ kind: "notice", message: "最新話です。" });
  });

  it("本文のある最終話では、次の話を作る（実機確認リスト F-35 の代わり）", () => {
    expect(planNeighborStep({ ...at(18), direction: "next" })).toEqual({
      kind: "create",
    });
  });

  it("話が1つだけの作品でも、同じ分かれ方になる（実機確認リスト F-35 の代わり）", () => {
    expect(
      planNeighborStep({
        at: 0,
        count: 1,
        direction: "next",
        currentIsBlank: true,
      })
    ).toEqual({ kind: "notice", message: "最新話です。" });
    expect(
      planNeighborStep({
        at: 0,
        count: 1,
        direction: "next",
        currentIsBlank: false,
      })
    ).toEqual({ kind: "create" });
  });

  it("最終話でなければ、白紙かどうかは見ない（実機確認リスト F-35 の代わり）", () => {
    // 途中の白紙の話を開いていても、次の話は既にある
    expect(
      planNeighborStep({ ...at(5, { blank: true }), direction: "next" })
    ).toEqual({ kind: "open", index: 6 });
  });
});
