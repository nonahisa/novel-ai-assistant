import { describe, expect, it } from "vitest";
import {
  episodePlotShortfall,
  judgeEpisodePlotText,
} from "../../../src/core/episodePlotDoc";

/**
 * 単話プロットが「揃っている」かの判定（画面の関門と外部AIの口で共通）。
 * ファイルがあるだけでは揃っていない——ひな形のままなら止める（2026-10-01）。
 */
describe("judgeEpisodePlotText", () => {
  it("ひな形のまま（どの欄も空）は、書かれていない", () => {
    const judged = judgeEpisodePlotText("");
    expect(judged.written).toBe(false);
    expect(judged.reason).toContain("ひな形のまま");
  });

  it("展開の箇条書きがあれば、書かれている", () => {
    const judged = judgeEpisodePlotText("## 展開\n- 主人公が旅立つ\n");
    expect(judged.written).toBe(true);
    expect(judged.reason).toBeUndefined();
  });
});

describe("episodePlotShortfall", () => {
  it("1つでも書かれていれば揃っている（6.94.6 の粗さ）", () => {
    expect(
      episodePlotShortfall([
        { plotPath: "a.md", written: false, reason: "x" },
        { plotPath: "b.md", written: true },
      ])
    ).toBeUndefined();
  });

  it("読めなかったものは揃っている扱い", () => {
    expect(
      episodePlotShortfall([{ plotPath: "a.md", written: null }])
    ).toBeUndefined();
  });

  it("ファイルが無ければ、無いと言う", () => {
    expect(episodePlotShortfall([])).toContain("まだありません");
  });

  it("全部ひな形なら、止める理由を返す", () => {
    expect(
      episodePlotShortfall([{ plotPath: "a.md", written: false, reason: "R。" }])
    ).toContain("a.md はありますが、R。");
    expect(
      episodePlotShortfall([
        { plotPath: "a.md", written: false },
        { plotPath: "b.md", written: false },
      ])
    ).toContain("2件ありますが");
  });
});
