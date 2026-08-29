import { describe, expect, test } from "vitest";
import {
  buildNameSuggestPrompt,
  isRejectedName,
  NAME_ORIGINS,
  NAME_SUGGEST_HINTS,
  NAME_SUGGEST_SCHEMA,
  parseNameSuggest,
} from "../../src/prompts/nameSuggest";
import {
  screenNameCandidates,
  type NameEntry,
} from "../../src/core/nameCollision";

function response(candidates: unknown[]): string {
  return JSON.stringify({ candidates });
}

describe("P-29 プロンプトの組み立て", () => {
  const base = {
    workTitle: "作品",
    currentName: "アリア",
    gender: "女性",
    role: "主人公",
    affiliation: "",
    existingNames: ["ミナ（みな）", "ミナモト（みなもと）"],
    setting: "中世風の王国",
  };

  test("既存の名前と世界観を渡す", () => {
    const prompt = buildNameSuggestPrompt(base);
    expect(prompt).toContain("ミナ（みな）");
    expect(prompt).toContain("中世風の王国");
    expect(prompt).toContain("アリア");
  });

  test("材料が無い項目は「未設定」と書いて渡す", () => {
    // 伏せると、AIは埋まっているものとして書いてくる
    const prompt = buildNameSuggestPrompt({ ...base, affiliation: "" });
    expect(prompt).toContain("（未設定）");
  });

  test("系統を指定すると、その系統だけを求める", () => {
    const prompt = buildNameSuggestPrompt({ ...base, origin: "北欧" });
    expect(prompt).toContain("北欧");
    expect(prompt).toContain("混ぜないこと");
  });

  test("指定なしなら、既存の名前から1つ見立てさせる", () => {
    const prompt = buildNameSuggestPrompt({ ...base, origin: undefined });
    expect(prompt).toContain("指定なし");
    // 選べる系統を全部並べて、その中から1つを選ばせる
    for (const origin of NAME_ORIGINS) expect(prompt).toContain(origin);
  });

  test("指示語をなぞらないよう、同じ定数から釘を刺す", () => {
    const prompt = buildNameSuggestPrompt(base);
    for (const hint of NAME_SUGGEST_HINTS) {
      expect(prompt).toContain(`「${hint}」`);
    }
  });

  test("スキーマは全項目 required", () => {
    // 任意にすると、地力の足りないモデルは埋めずに落とす
    const item = NAME_SUGGEST_SCHEMA.properties.candidates.items;
    expect(item.required).toEqual(["name", "reading", "origin", "note"]);
    expect(NAME_SUGGEST_SCHEMA.required).toEqual(["candidates"]);
  });
});

describe("応答の読み取り", () => {
  test("候補を読み取る", () => {
    const parsed = parseNameSuggest(
      response([
        { name: "セラフィナ", reading: "せらふぃな", origin: "北欧", note: "光の意" },
      ])
    );
    expect(parsed).toEqual([
      { name: "セラフィナ", reading: "せらふぃな", origin: "北欧", note: "光の意" },
    ]);
  });

  test("コードフェンス付きでも読む", () => {
    const parsed = parseNameSuggest(
      "```json\n" + response([{ name: "レオン", reading: "れおん", origin: "フランス", note: "獅子" }]) + "\n```"
    );
    expect(parsed).toHaveLength(1);
  });

  test("指示語のなぞりは候補にしない", () => {
    // 「候補1」「名前」がそのまま返ることがある（この作品の失敗3の型）
    const parsed = parseNameSuggest(
      response([
        { name: "名前", reading: "", origin: "和風", note: "" },
        { name: "候補", reading: "", origin: "和風", note: "" },
        { name: "サクラ", reading: "さくら", origin: "和風", note: "花の名" },
      ])
    );
    expect(parsed.map((entry) => entry.name)).toEqual(["サクラ"]);
  });

  test("中身の無い言葉は候補にしない", () => {
    const parsed = parseNameSuggest(
      response([{ name: "なし", reading: "", origin: "和風", note: "" }])
    );
    expect(parsed).toHaveLength(0);
  });

  test("同じ名前が2度来たら先に来たほうを残す", () => {
    const parsed = parseNameSuggest(
      response([
        { name: "レオン", reading: "れおん", origin: "フランス", note: "獅子" },
        { name: "レオン", reading: "れおん", origin: "ドイツ", note: "別の説明" },
      ])
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].origin).toBe("フランス");
  });

  test("説明が空でも候補は落とさない", () => {
    // 名前さえ使えれば選べる。1項目のために全部を捨てない
    const parsed = parseNameSuggest(
      response([{ name: "レオン", reading: "れおん", origin: "特になし", note: "なし" }])
    );
    expect(parsed[0].name).toBe("レオン");
    expect(parsed[0].note).toBe("");
    expect(parsed[0].origin).toBe("");
  });

  test("壊れた応答では空を返す", () => {
    expect(parseNameSuggest("すみません、出せません")).toEqual([]);
    expect(parseNameSuggest("{壊れている")).toEqual([]);
  });

  test("なぞりの判定は完全一致で行う", () => {
    // 「名」の字が入っている名前まで落としてはいけない
    expect(isRejectedName("名前")).toBe(true);
    expect(isRejectedName("名護屋")).toBe(false);
  });
});

describe("候補の絞り込み（判定はコードで行う）", () => {
  const existing: NameEntry[] = [
    { id: "a", kind: "character", name: "ミナ" },
    { id: "b", kind: "character", name: "アリア" },
    { id: "self", kind: "character", name: "サリア" },
  ];

  test("既存の名前と響きが重なる候補を、理由つきで落とす", () => {
    const screened = screenNameCandidates(
      [
        { name: "ミナモト", reading: "みなもと" },
        { name: "セラフィナ", reading: "せらふぃな" },
      ],
      existing,
      { excludeId: "self" }
    );
    expect(screened.kept.map((entry) => entry.name)).toEqual(["セラフィナ"]);
    expect(screened.dropped[0].candidate.name).toBe("ミナモト");
    expect(screened.dropped[0].reason).toContain("ミナ");
  });

  test("付け替える本人とは比べない", () => {
    // いまの名前と似ているかどうかは、この場面では意味がない
    const screened = screenNameCandidates([{ name: "サリナ", reading: "さりな" }], existing, {
      excludeId: "self",
    });
    expect(screened.kept.map((entry) => entry.name)).toEqual(["サリナ"]);
  });

  test("除外を指定しなければ、本人とも比べる", () => {
    const screened = screenNameCandidates(
      [{ name: "サリナ", reading: "さりな" }],
      existing
    );
    expect(screened.kept).toHaveLength(0);
  });

  test("黙って減らさない（落とした数が残る）", () => {
    const screened = screenNameCandidates(
      [
        { name: "ミナモト", reading: "みなもと" },
        { name: "アリサ", reading: "ありさ" },
      ],
      existing,
      { excludeId: "self" }
    );
    expect(screened.kept).toHaveLength(0);
    expect(screened.dropped).toHaveLength(2);
    for (const entry of screened.dropped) expect(entry.reason).toBeTruthy();
  });
});
