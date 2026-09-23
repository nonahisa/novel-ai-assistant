import { describe, expect, it } from "vitest";
import {
  arityOf,
  canonicalPredicate,
  isExclusivePredicate,
} from "../../../src/core/predicateArity";

/**
 * 項目ごとの「同時に1つか、いくつでもか」（設計書6.88.6）。
 *
 * **表に無い名前は「いくつでも」に倒す**——項目名はAIが自由に付けるので、
 * 表に無いものは必ず出る。そこを排他に倒すと、値を比べる意味の無い項目
 * （台詞・発言・行動）が全部候補になる。
 */
describe("項目ごとの排他性", () => {
  it("居場所・生死・所属は同時に1つ", () => {
    expect(arityOf("所在")).toBe("exclusive");
    expect(arityOf("死亡")).toBe("exclusive");
    expect(arityOf("所属")).toBe("exclusive");
  });

  it("所持品・能力は同時にいくつでも成り立つ", () => {
    expect(arityOf("所持品")).toBe("multiple");
    expect(arityOf("能力")).toBe("multiple");
  });

  it("値を比べる意味の無い項目も、同時にいくつでも", () => {
    // 実測（2026-09-18）で抽出が返した名前。これを排他に倒すと候補が爆発する
    expect(arityOf("台詞")).toBe("multiple");
    expect(arityOf("発言")).toBe("multiple");
    expect(arityOf("行動")).toBe("multiple");
  });

  it("表に無い名前は「いくつでも」（迷ったら出さない）", () => {
    expect(arityOf("作者が足した謎の項目")).toBe("multiple");
    expect(isExclusivePredicate("作者が足した謎の項目")).toBe(false);
  });

  it("前後の空白は無視する", () => {
    expect(arityOf(" 髪の色 ")).toBe("exclusive");
  });

  it("部分一致では引かない（表を読んだ人の予想と食い違わせない）", () => {
    // 「怪我」は排他だが、「怪我の記録」という別の名前は表に無い
    expect(arityOf("怪我")).toBe("exclusive");
    expect(arityOf("怪我の記録")).toBe("multiple");
  });

  it("人物レコードの項目名は引ける（資料と本文が突き合わされるため）", () => {
    for (const label of ["外見", "性格", "役割", "性別", "所属", "名前"]) {
      expect(isExclusivePredicate(label)).toBe(true);
    }
  });
});

/**
 * 項目名の言い換え（0.67.5）。
 *
 * 資料の側は人物レコードの項目名しか出さないので、本文の抽出が付けた
 * 名前をそこへ寄せないと、**一度も突き合わされない。**
 */
describe("項目名を正式名へ寄せる", () => {
  it("本文の「身体的特徴」は資料の「外見」へ寄る", () => {
    expect(canonicalPredicate("身体的特徴")).toBe("外見");
  });

  it("表に無い名前はそのまま（推測で言い換えない）", () => {
    expect(canonicalPredicate("怪我")).toBe("怪我");
    expect(canonicalPredicate("作者が足した謎の項目")).toBe("作者が足した謎の項目");
  });

  it("前後の空白は落とす", () => {
    expect(canonicalPredicate(" 身体的特徴 ")).toBe("外見");
  });

  /**
   * 自由文どうしを値として比べても、出るのは言い回しの違いだけである。
   * 「紹介」を排他の表から外したのと同じ理由で、ここへも入れない。
   */
  it("自由文の項目（性質→性格）は寄せない", () => {
    expect(canonicalPredicate("性質")).toBe("性質");
    expect(arityOf("性質")).toBe("multiple");
  });

  it("排他性は寄せたあとの名前で決まる", () => {
    // 「身体的特徴」は排他の表にも載っているが、寄せたあとの「外見」で
    // 引いても同じ答えになる（表の片方だけを直しても食い違わない）
    expect(arityOf("身体的特徴")).toBe("exclusive");
  });
});
