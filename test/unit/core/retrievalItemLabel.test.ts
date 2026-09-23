import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  describeRetrievedItem,
  describeRetrievedItems,
  manuscriptItems,
  type RetrievalItem,
} from "../../../src/core/retrievalCorpus";

/**
 * 操作ログの札に、同じ話のどの場面かの連番を付ける（作者の裁定、2026-09-23。残課題 A6）。
 *
 * ## 何が起きていたか
 *
 * 相談の記録に「本文・第12話、本文・第12話、本文・第12話、本文・第12話」と
 * 同じ札が4回並んだ。**同じ話の別の場面（検索用に分けた塊）で、重複ではない**
 * が、札だけでは見分けられず、重複して渡したように読める。
 *
 * ## 裁定
 *
 * `本文・第12話（1/4）` の形にする。**同じ話が複数の場面に分かれるときだけ**
 * 付け、1つだけなら付けない。
 */

/** 1場面ぶんに収まらない長さの本文（行ごとに区切れるよう改行を入れる） */
function longEpisode(lines: number): string {
  return Array.from({ length: lines }, (_, index) =>
    `${index + 1}行目。灯は王都の石畳を歩き、門番に通行証を見せた。`.repeat(4)
  ).join("\n");
}

describe("本文の場面に、話の中の位置を持たせる", () => {
  test("複数の場面に分かれた話は、何番目か／いくつ中かを持つ", () => {
    const items = manuscriptItems("第12話", longEpisode(60));
    expect(items.length).toBeGreaterThan(1);
    expect(items.map((item) => item.part)).toEqual(
      items.map((_, index) => ({ index: index + 1, total: items.length }))
    );
    // 出典の名前（AIへ示すもの）は変えない
    expect(items.every((item) => item.label === "第12話")).toBe(true);
  });

  test("1つの場面に収まる話は、位置を持たない", () => {
    const items = manuscriptItems("第1話", "灯は目を覚ました。");
    expect(items).toHaveLength(1);
    expect(items[0].part).toBeUndefined();
  });
});

describe("記録に出す札", () => {
  const base: RetrievalItem = {
    id: "本文:第12話#1",
    source: "本文",
    label: "第12話",
    text: "……",
    hash: "x",
    authorWritten: false,
  };

  test("同じ話が4回並べば（1/4）〜（4/4）——分母は一覧に並んだ回数（作者の例）", () => {
    // 話の中の場面の数（part.total＝9）ではなく、並んだ回数（4）で数える
    const four = [1, 3, 5, 7].map((index) => ({
      ...base,
      id: `本文:第12話#${index}`,
      part: { index, total: 9 },
    }));
    expect(describeRetrievedItems(four)).toEqual([
      "本文・第12話（1/4）",
      "本文・第12話（2/4）",
      "本文・第12話（3/4）",
      "本文・第12話（4/4）",
    ]);
  });

  test("1回だけ並んだ札・設定資料・あらすじには付けない", () => {
    const setting: RetrievalItem = {
      ...base,
      source: "設定資料",
      label: "登場人物: 太志",
    };
    const other: RetrievalItem = { ...base, label: "第3話" };
    expect(
      describeRetrievedItems([base, setting, other, { ...base, id: "本文:第12話#2" }])
    ).toEqual([
      "本文・第12話（1/2）",
      "設定資料・登場人物: 太志",
      "本文・第3話",
      "本文・第12話（2/2）",
    ]);
    expect(describeRetrievedItem({ ...base, part: { index: 2, total: 9 } })).toBe(
      "本文・第12話"
    );
  });

  test("札を作る所は、この1か所を通す（写しを作らない）", () => {
    for (const file of ["features/workChatPanel.ts", "features/settingsPanel.ts"]) {
      const source = readFileSync(resolve(__dirname, "../../../src", file), "utf8");
      expect(source, file).not.toContain("${candidate.item.source}・${candidate.item.label}");
      expect(source, file).toContain("describeRetrievedItems(");
    }
  });
});

/**
 * **話の題が話数で始まる作品で、札に話数が2回並んだ**（ノートPCの実機、0.76.1、2026-09-23）。
 *
 * 相談の操作ログに「本文・第1話 第1話　薄皮の向こう側（1/11）」と出た。
 * 出典の名前（`label`）は「話数 ＋ 題」で作られ（`core/manuscriptSources.ts` の
 * `episodeLabel`）、この作品は題そのものが「第1話　薄皮の向こう側」だった。
 *
 * **AIへ渡す出典（`label`）は変えない**——変えるとプロンプトの中身が変わり、
 * 版とキャッシュに響く。直すのは記録の札だけ。
 */
describe("題が話数で始まる話の札", () => {
  const titled: RetrievalItem = {
    id: "本文:第1話 第1話　薄皮の向こう側#0",
    source: "本文",
    label: "第1話 第1話　薄皮の向こう側",
    text: "……",
    hash: "x",
    authorWritten: false,
  };

  test("話数を重ねない（作者の例）", () => {
    expect(describeRetrievedItem(titled)).toBe("本文・第1話　薄皮の向こう側");
  });

  test("連番も、重ねを畳んだ札に付く", () => {
    const eleven = Array.from({ length: 11 }, (_, index) => ({
      ...titled,
      id: `本文:第1話 第1話　薄皮の向こう側#${index}`,
    }));
    expect(describeRetrievedItems(eleven)[0]).toBe("本文・第1話　薄皮の向こう側（1/11）");
  });

  test("全角の数字で書いた題も、同じ話数として畳む（題の書き方はそのまま残す）", () => {
    expect(
      describeRetrievedItem({ ...titled, label: "第1話 第１話　薄皮の向こう側" })
    ).toBe("本文・第１話　薄皮の向こう側");
  });

  test("題が話数で始まらなければ、これまでどおり話数と題を並べる", () => {
    expect(
      describeRetrievedItem({ ...titled, label: "第1話 薄皮の向こう側" })
    ).toBe("本文・第1話 薄皮の向こう側");
    // 「第1話」と「第12話」は別の話数（前方一致で畳まない）
    expect(
      describeRetrievedItem({ ...titled, label: "第1話 第12話の手前で" })
    ).toBe("本文・第1話 第12話の手前で");
  });

  test("設定資料の札は触らない", () => {
    expect(
      describeRetrievedItem({ ...titled, source: "設定資料", label: "登場人物: 太志" })
    ).toBe("設定資料・登場人物: 太志");
  });

  test("AIへ渡す出典（label）は変えない", () => {
    const items = manuscriptItems("第1話 第1話　薄皮の向こう側", "灯は目を覚ました。");
    expect(items[0].label).toBe("第1話 第1話　薄皮の向こう側");
  });
});
