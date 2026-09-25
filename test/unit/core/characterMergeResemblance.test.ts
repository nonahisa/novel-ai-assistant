import { describe, expect, test } from "vitest";
import { mergeExtractedCharacters } from "../../../src/core/characterMerge";
import {
  RESEMBLANCE_THRESHOLD,
  textSimilarity,
} from "../../../src/core/characterResemblance";
import { describeConflictValues } from "../../../src/core/settingsMarkdown";
import { parseConflicts } from "../../../src/models/jsonValidation";
import type { ExtractedCharacter } from "../../../src/prompts/characterExtract";

/**
 * 別人の記述が人物の資料に混ざったとき（精査 F4、作者の判断 2026-09-25 案B）。
 *
 * 実データ（ハイエルフ未亡人のお気楽資産運用）で、コリンナ（メイド）の資料に
 * ナイン（主人）の第1話の記述が混ざった。role だけは食い違いとして止まったが、
 * summary・appearance は「作中の変化」として積まれた。マージが新しい値の話数を
 * **いまの値**とだけ比べ、変化の履歴にある同じ話の値とは比べないためである。
 *
 * 作者が選んだ直し方：新しい値が**同じ作品の別の人物の同じ項目の記述**と
 * 似ているときだけ、作中の変化に積まずに食い違いとして止め、
 * 「ナインの記述と似ています」と添える。
 */
function item(
  data: Partial<ExtractedCharacter> & { name: string },
  chapters: number[]
): { data: ExtractedCharacter; chapters: number[] } {
  // 根拠（本文の引用）を付けておく。根拠の無い変化は本体を動かさない
  // （作者の裁定、2026-09-23）ので、付けないと「本体の値」を確かめられない
  return {
    data: { aliases: [], evidence: "「はい」", ...data } as ExtractedCharacter,
    chapters,
  };
}

/** 1回目の抽出：2人とも本人の記述で資料ができている（実データの値） */
function firstPass() {
  return mergeExtractedCharacters(
    [],
    [
      item(
        {
          name: "ナイン",
          role: "元王妃",
          summary: "不死妃の宮の主。かつて王妃であったエルフの女性。",
          appearance:
            "金貨と同じ色の金髪。絵画の中にでてくるようなひらひらドレスを着ている。",
        },
        [1]
      ),
      item(
        {
          name: "コリンナ",
          role: "メイド",
          summary: "不死妃の宮で働くエルフのメイド。",
          appearance: "アッシュブロンドの髪を編んでたばねている。",
        },
        [1]
      ),
      item(
        {
          name: "コリンナ",
          role: "メイド",
          summary: "ナインに仕えるエルフの侍女。",
          appearance: "メイド服を着たエルフ。",
        },
        [3]
      ),
    ]
  ).characters;
}

/** 2回目の抽出で、第1話のコリンナにナインの記述が混ざった（実データの値） */
const MIXED = item(
  {
    name: "コリンナ",
    role: "不死妃の宮の主",
    summary: "不死妃の宮の主。かつて王妃であった金髪のエルフ。",
    appearance: "金貨と同じ色の金髪。ひらひらドレスを着用している。",
  },
  [1]
);

describe("別の人物の記述に似た値は、作中の変化に積まずに食い違いとして止める（F4）", () => {
  test("summary・appearance も role と同じく食い違いとして止まる", () => {
    const result = mergeExtractedCharacters(firstPass(), [MIXED]);
    const corinna = result.characters.find((c) => c.name === "コリンナ");
    expect(corinna).toBeDefined();
    if (!corinna) return;

    // 作中の変化へは積まない
    const changed = corinna.changes.map((change) => change.value);
    expect(changed).not.toContain(MIXED.data.summary);
    expect(changed).not.toContain(MIXED.data.appearance);

    // 食い違いとして作者の判断へ回る
    const fields = corinna.conflicts.map((conflict) => conflict.field);
    expect(fields).toEqual(expect.arrayContaining(["role", "summary", "appearance"]));

    // 本体は動かない（いちばん後ろの話＝第3話の本人の値のまま）
    expect(corinna.summary).toBe("ナインに仕えるエルフの侍女。");
    expect(corinna.appearance).toBe("メイド服を着たエルフ。");

    // 完了報告にも食い違いとして出る
    expect(
      result.conflicts
        .filter((entry) => entry.characterName === "コリンナ")
        .map((entry) => entry.field)
    ).toEqual(expect.arrayContaining(["summary", "appearance"]));
  });

  test("止めた値には、似ている相手の名前が付き、資料に「ナインの記述と似ています」と出る", () => {
    const result = mergeExtractedCharacters(firstPass(), [MIXED]);
    const corinna = result.characters.find((c) => c.name === "コリンナ");
    const summary = corinna?.conflicts.find((c) => c.field === "summary");
    expect(summary).toBeDefined();
    if (!summary) return;
    const observation = summary.observations?.find(
      (entry) => entry.value === MIXED.data.summary
    );
    expect(observation?.resembles).toBe("ナイン");
    expect(describeConflictValues(summary)).toContain("ナインの記述と似ています");

    // role は照合しない項目（別人と同じ値が当たり前）なので、何も添えない
    const role = corinna?.conflicts.find((c) => c.field === "role");
    expect(role ? describeConflictValues(role) : "").not.toContain("似ています");
  });

  test("止めた食い違いは、次の抽出で作中の変化へ畳まれない", () => {
    const once = mergeExtractedCharacters(firstPass(), [MIXED]).characters;
    // 何も新しいことの無い抽出をもう1回（畳む処理は毎回、全員へ掛かる）
    const twice = mergeExtractedCharacters(once, [
      item({ name: "コリンナ", summary: "ナインに仕えるエルフの侍女。" }, [3]),
    ]);
    const corinna = twice.characters.find((c) => c.name === "コリンナ");
    expect(corinna?.conflicts.map((c) => c.field)).toEqual(
      expect.arrayContaining(["summary", "appearance"])
    );
    expect(twice.folded.filter((f) => f.characterName === "コリンナ")).toEqual([]);
  });

  test("ナインの資料は変わらない（相手の側には何もしない）", () => {
    const before = firstPass().find((c) => c.name === "ナイン");
    const result = mergeExtractedCharacters(firstPass(), [MIXED]);
    const nine = result.characters.find((c) => c.name === "ナイン");
    expect(nine?.conflicts).toEqual(before?.conflicts);
    expect(nine?.changes).toEqual(before?.changes);
  });

  test("本人の新しい話の値は、これまでどおり作中の変化として積む", () => {
    const result = mergeExtractedCharacters(firstPass(), [
      item({ name: "コリンナ", summary: "ナインの側近。事務的な対応を行うメイド。" }, [5]),
    ]);
    const corinna = result.characters.find((c) => c.name === "コリンナ");
    expect(corinna?.conflicts).toEqual([]);
    expect(corinna?.summary).toBe("ナインの側近。事務的な対応を行うメイド。");
  });

  test("別の人物に似ていても、その人の記述が別の話のものなら止めない", () => {
    // 第1話のナインに似た値でも、コリンナの第7話として来たなら、
    // 同じ場面から2人ぶんの記述が出たとは言えない
    const result = mergeExtractedCharacters(firstPass(), [
      item({ name: "コリンナ", summary: MIXED.data.summary }, [7]),
    ]);
    const corinna = result.characters.find((c) => c.name === "コリンナ");
    expect(corinna?.conflicts.map((c) => c.field)).not.toContain("summary");
  });

  test("自分の記述のほうに似ているなら止めない（2人とも同じように描かれた場面）", () => {
    const existing = mergeExtractedCharacters(
      [],
      [
        item({ name: "ウィーネ", summary: "冒険者ギルド西門支部の受付職員。" }, [1]),
        item({ name: "支部長", summary: "冒険者ギルド西門支部の責任者。" }, [2]),
      ]
    ).characters;
    // 第2話のウィーネの値は、同じ話の支部長の記述にも似ているが、
    // 本人の第1話の記述のほうにもっと似ている
    const result = mergeExtractedCharacters(existing, [
      item({ name: "ウィーネ", summary: "冒険者ギルド西門支部の職員。" }, [2]),
    ]);
    const wiene = result.characters.find((c) => c.name === "ウィーネ");
    expect(wiene?.conflicts.map((c) => c.field)).not.toContain("summary");
  });

  test("所属・役割のように、別人と同じ値が当たり前の項目では止めない", () => {
    const existing = mergeExtractedCharacters(
      [],
      [
        item({ name: "プラム", affiliation: "不死妃の宮", role: "料理人" }, [2]),
        item({ name: "エルシー", affiliation: "冒険者ギルド", role: "冒険者" }, [1]),
      ]
    ).characters;
    const result = mergeExtractedCharacters(existing, [
      item({ name: "エルシー", affiliation: "不死妃の宮", role: "料理人" }, [2]),
    ]);
    const elsie = result.characters.find((c) => c.name === "エルシー");
    expect(elsie?.conflicts).toEqual([]);
    expect(elsie?.affiliation).toBe("不死妃の宮");
  });

  test("似かたの測り方：実例の取り違えは閾値を超え、短い値の包含だけでは満点にしない", () => {
    // 実データで混ざった値と、持ち主の記述
    expect(
      textSimilarity(
        "不死妃の宮の主。かつて王妃であった金髪のエルフ。",
        "不死妃の宮の主。かつて王妃であったエルフの女性。"
      )
    ).toBeGreaterThanOrEqual(RESEMBLANCE_THRESHOLD);
    expect(
      textSimilarity(
        "金貨と同じ色の金髪。ひらひらドレスを着用している。",
        "金貨と同じ色の金髪。絵画の中にでてくるようなひらひらドレスを着ている。"
      )
    ).toBeGreaterThanOrEqual(RESEMBLANCE_THRESHOLD);
    // 本人の記述とは似ていない
    expect(
      textSimilarity(
        "不死妃の宮の主。かつて王妃であった金髪のエルフ。",
        "不死妃の宮で働くエルフのメイド。"
      )
    ).toBeLessThan(RESEMBLANCE_THRESHOLD);
    // 句読点・空白の違いは同じとみなす
    expect(textSimilarity("黒髪、短髪。", "黒髪 短髪")).toBe(1);
    // 短い値が長い値に含まれるだけでは満点にしない
    expect(textSimilarity("黒髪", "黒髪を肩で切りそろえた少女")).toBeLessThan(
      RESEMBLANCE_THRESHOLD
    );
  });

  test("似ている相手の名前は、読み込み直しても落ちない", () => {
    const parsed = parseConflicts([
      {
        field: "summary",
        values: ["A", "B"],
        chapters: [1],
        note: null,
        observations: [
          { value: "A", chapters: [3] },
          { value: "B", chapters: [1], resembles: "ナイン" },
        ],
      },
    ]);
    expect(parsed?.[0].observations?.[1].resembles).toBe("ナイン");
  });
});
