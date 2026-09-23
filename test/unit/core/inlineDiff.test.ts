import { describe, it, expect } from "vitest";
import { diffChars, type DiffSegment } from "../../src/core/inlineDiff";

/**
 * 提案パネルで、違うところだけを塗る（設計書6.11.2）。
 *
 * **作者の指摘**（2026-08-21）。「差異のある部分をマーカーで色分けして
 * ください」。推敲の指摘は文まるごとが対象になるので、行全体に色を付けると
 * どこが変わるのか目で追えない。
 */

/** 消える側（equal + removed）を組み立て直す */
function before(segments: DiffSegment[]): string {
  return segments
    .filter((s) => s.kind !== "added")
    .map((s) => s.text)
    .join("");
}

/** 残る側（equal + added）を組み立て直す */
function after(segments: DiffSegment[]): string {
  return segments
    .filter((s) => s.kind !== "removed")
    .map((s) => s.text)
    .join("");
}

/** 塗られる文字だけを取り出す。「どこが色づくか」を目で確かめるため */
function marked(segments: DiffSegment[], kind: "removed" | "added"): string[] {
  return segments.filter((s) => s.kind === kind).map((s) => s.text);
}

describe("並べ直せば元に戻る", () => {
  const 組 = [
    ["呪詛だらけの学校は視界が悪いので、引き寄せて視界を確保する。", "呪詛だらけの学校は視界が悪いので、引き寄せて確保する。"],
    ["走つた", "走った"],
    ["意外", "以外"],
    ["", "足した"],
    ["消えた", ""],
    ["まったく別の文です", "共通するところが何も無い"],
  ];

  for (const [a, b] of 組) {
    it(`「${a}」→「${b}」`, () => {
      // **ここが崩れると本文が壊れる。** 画面に出すだけとはいえ、
      // 作者は塗られたものを見て適用を決める
      const segments = diffChars(a, b);
      expect(before(segments)).toBe(a);
      expect(after(segments)).toBe(b);
    });
  }
});

describe("作者の画面に出ていたもの", () => {
  it("消える3文字だけが塗られる", () => {
    const segments = diffChars(
      "呪詛だらけの学校は視界が悪いので、引き寄せて視界を確保する。",
      "呪詛だらけの学校は視界が悪いので、引き寄せて確保する。"
    );
    expect(marked(segments, "removed")).toEqual(["視界を"]);
    expect(marked(segments, "added")).toEqual([]);
  });

  it("足した助詞だけが塗られる", () => {
    // 「全員廊下側の…ようしゃがんでいて」→「全員が廊下側の…ようにしゃがんでいて」
    const segments = diffChars(
      "全員廊下側の窓に影がうつらないようしゃがんでいて、ちょっと滑稽な光景だ。",
      "全員が廊下側の窓に影がうつらないようにしゃがんでいて、ちょっと滑稽な光景だ。"
    );
    expect(marked(segments, "added")).toEqual(["が", "に"]);
    expect(marked(segments, "removed")).toEqual([]);
  });
});

describe("誤字脱字のよくある形", () => {
  it("同音異義語は、その1文字だけ", () => {
    const segments = diffChars("意外", "以外");
    expect(marked(segments, "removed")).toEqual(["意"]);
    expect(marked(segments, "added")).toEqual(["以"]);
    // 共通の「外」は塗らない
    expect(segments.some((s) => s.kind === "equal" && s.text === "外")).toBe(true);
  });

  it("促音の直しは、その1文字だけ", () => {
    const segments = diffChars("走つた", "走った");
    expect(marked(segments, "removed")).toEqual(["つ"]);
    expect(marked(segments, "added")).toEqual(["っ"]);
  });

  it("送り仮名は、落ちる仮名だけ", () => {
    const segments = diffChars("行なう", "行う");
    expect(marked(segments, "removed")).toEqual(["な"]);
    expect(marked(segments, "added")).toEqual([]);
  });

  it("末尾へ足す直しは、足した分だけ", () => {
    const segments = diffChars("取り", "取り憑く");
    expect(marked(segments, "added")).toEqual(["憑く"]);
    expect(marked(segments, "removed")).toEqual([]);
  });
});

describe("虫食いを出さない", () => {
  it("共通するところが無ければ、まるごと塗る", () => {
    const segments = diffChars("まったく別の文です", "共通するところが何も無い");
    expect(segments).toEqual([
      { kind: "removed", text: "まったく別の文です" },
      { kind: "added", text: "共通するところが何も無い" },
    ]);
  });

  it("文の書き換えを1文字ずつ照らし合わせない", () => {
    // **たまたま同じ仮名が拾われると、虫食いになって読めない。**
    // そうなるくらいなら、まるごと消してまるごと足すほうが読める
    const segments = diffChars(
      "彼はそこにいたのだと、あとから思い返している",
      "そのとき彼女がいたことを、のちに知ることになる"
    );
    expect(segments.length).toBeLessThanOrEqual(4);
    expect(before(segments)).toBe("彼はそこにいたのだと、あとから思い返している");
  });
});

describe("端の扱い", () => {
  it("同じ文字列なら、違いは無い", () => {
    expect(diffChars("同じ", "同じ")).toEqual([{ kind: "equal", text: "同じ" }]);
  });

  it("両方とも空なら、何も返さない", () => {
    expect(diffChars("", "")).toEqual([]);
  });

  it("片方が空なら、もう片方をまるごと塗る", () => {
    expect(diffChars("", "足した")).toEqual([{ kind: "added", text: "足した" }]);
    expect(diffChars("消えた", "")).toEqual([{ kind: "removed", text: "消えた" }]);
  });

  it("サロゲートペアを割らない", () => {
    // **文字単位で切ると、一部の漢字や絵文字が2つに割れて壊れる**
    const segments = diffChars("𠮷野家へ行く", "𠮷野家へ来る");
    expect(before(segments)).toBe("𠮷野家へ行く");
    expect(after(segments)).toBe("𠮷野家へ来る");
    for (const segment of segments) {
      // 半分だけの符号が残っていないこと
      expect(segment.text).toBe(Array.from(segment.text).join(""));
      expect(segment.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(segment.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });

  it("長い文でも、待たされない", () => {
    // パネルは開きっぱなしにする場所なので、重い計算をさせない
    const long = "あいうえおかきくけこ".repeat(200);
    const started = process.hrtime.bigint();
    const segments = diffChars(long, long.slice(0, 1000) + "違う" + long.slice(1000));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    expect(elapsedMs).toBeLessThan(200);
    expect(before(segments)).toBe(long);
  });
});
