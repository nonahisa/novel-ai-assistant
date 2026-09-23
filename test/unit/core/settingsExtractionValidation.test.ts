import { describe, expect, test } from "vitest";
import type { Chunk } from "../../src/core/chunker";
import {
  normalizeExtractedAbilitySystem,
  validateExtractedAbilities,
  validateExtractedLocations,
} from "../../src/core/settingsExtractionValidation";

const sourceLine = "「灯火よ、道を示せ」と灯が唱えた";
const chunk: Chunk = {
  filePath: "001.txt",
  index: 0,
  text: `${sourceLine}。\n図書塔の階段を上る。\n王都リヴェルスの空は暗い。`,
  startLine: 0,
  hash: "fixture",
  chapterStart: 3,
  chapterEnd: 3,
};

describe("能力の検証", () => {
  test("本文に実在する能力を話数付きで受理する", () => {
    const result = validateExtractedAbilities(
      [{ name: "灯火", evidence: sourceLine, userNames: ["灯"] }],
      chunk
    );

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].chapters).toEqual([3]);
    expect(result.accepted[0].data.userNames).toEqual(["灯"]);
  });

  test("本文にない能力を捏造として除外する", () => {
    const result = validateExtractedAbilities(
      [{ name: "業火", evidence: "「業火よ」と叫んだ" }],
      chunk
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ name: "業火", reason: "ungrounded" }]);
  });

  test("名前は本物でも引用が捏造なら除外する", () => {
    const result = validateExtractedAbilities(
      [{ name: "灯火", evidence: "灯火は空を焼き尽くした" }],
      chunk
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ name: "灯火", reason: "ungrounded" }]);
  });

  test("文がそのまま名前になっている候補を除外する", () => {
    const result = validateExtractedAbilities(
      [{ name: "灯火を唱えると、光が灯る。", evidence: sourceLine }],
      chunk
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]?.reason).toBe("invalid_name");
  });

  test.each(["null", "不明", "なし", "特になし"])(
    "プレースホルダー名 %s を除外する",
    (name) => {
      const result = validateExtractedAbilities(
        [{ name, evidence: sourceLine }],
        chunk
      );

      expect(result.rejected).toEqual([{ name, reason: "invalid_name" }]);
    }
  );

  test.each([
    // 実データ（能力体系の無い作品）でAIが返してきた候補。
    // 無いものを探させると、AIは総称や説明文で埋めようとする。
    "左手だけでなんとかできる",
    "左手一本で扱う短剣だけ",
    "魔力",
    "スキル",
    "戦闘能力",
    "冒険者ギルドの保険制度",
  ])("能力名でない候補 %s を除外する", (name) => {
    const line = `${name}のことを考えた`;
    const result = validateExtractedAbilities(
      [{ name, evidence: line }],
      { ...chunk, text: line }
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ name, reason: "not_an_ability" }]);
  });

  test("総称そのものは能力名にしない", () => {
    const line = "彼は魔法を使った";
    const result = validateExtractedAbilities(
      [{ name: "魔法", evidence: line }],
      { ...chunk, text: line },
      "魔法"
    );

    expect(result.rejected).toEqual([{ name: "魔法", reason: "not_an_ability" }]);
  });

  test.each(["灯火", "身体強化", "風刃", "縮地"])(
    "個別の能力名 %s は通す",
    (name) => {
      const line = `${name}を使った`;
      const result = validateExtractedAbilities(
        [{ name, evidence: line }],
        { ...chunk, text: line }
      );

      expect(result.rejected).toEqual([]);
      expect(result.accepted).toHaveLength(1);
    }
  );

  test("配列でない入力を受け取っても落ちない", () => {
    expect(validateExtractedAbilities(undefined, chunk)).toEqual({
      accepted: [],
      rejected: [],
    });
  });
});

describe("場所の検証", () => {
  test("本文に実在する場所を受理する", () => {
    const result = validateExtractedLocations(
      [{ name: "図書塔", region: "王都リヴェルス", evidence: "図書塔の階段を上る" }],
      chunk
    );

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].data.region).toBe("王都リヴェルス");
  });

  test.each(["ここ", "そこ", "あの街", "この部屋"])(
    "指示語 %s は特定の場所を指さないので除外する",
    (name) => {
      const result = validateExtractedLocations(
        [{ name, evidence: "図書塔の階段を上る" }],
        chunk
      );

      expect(result.accepted).toEqual([]);
      expect(result.rejected).toEqual([{ name, reason: "invalid_name" }]);
    }
  );

  test("本文にない場所を捏造として除外する", () => {
    const result = validateExtractedLocations(
      [{ name: "水晶宮", evidence: "水晶宮の門をくぐる" }],
      chunk
    );

    expect(result.rejected).toEqual([{ name: "水晶宮", reason: "ungrounded" }]);
  });
});

describe("能力体系の総称", () => {
  test("短い名詞は総称として採用する", () => {
    expect(
      normalizeExtractedAbilitySystem({ abilityTerm: "魔法" })?.abilityTerm
    ).toBe("魔法");
  });

  test("文になっている値は読み取り失敗として捨てる", () => {
    // 「この世界では魔法と呼ばれている。」のような応答を総称にしない
    const result = normalizeExtractedAbilitySystem({
      abilityTerm: "この世界では魔法と呼ばれている。",
    });

    expect(result?.abilityTerm ?? null).toBeNull();
  });

  test("長すぎる値も総称にしない", () => {
    const result = normalizeExtractedAbilitySystem({
      abilityTerm: "とてもながいのうりょくのそうしょう",
    });

    expect(result?.abilityTerm ?? null).toBeNull();
  });

  test("何も読み取れなければundefinedを返す", () => {
    expect(normalizeExtractedAbilitySystem({})).toBeUndefined();
    expect(normalizeExtractedAbilitySystem(null)).toBeUndefined();
  });

  test("規則だけ読み取れた場合は保持する", () => {
    const result = normalizeExtractedAbilitySystem({
      abilityTerm: null,
      rules: ["詠唱には3秒を要する", ""],
    });

    expect(result?.rules).toEqual(["詠唱には3秒を要する"]);
  });
});

describe("ジャンル名を総称にしない", () => {
  test.each([
    // 実データで返ってきた値。「能力の呼び名」を聞くとジャンルで答えることがある
    "ファンタジー",
    "ファンタジー/伝奇",
    "伝奇",
    "異世界ファンタジー",
    "SF",
  ])("%s は総称として採らない", (value) => {
    const result = normalizeExtractedAbilitySystem({ abilityTerm: value });

    expect(result?.abilityTerm ?? null).toBeNull();
  });

  test.each(["神術", "仙術", "魔法", "スキル", "異能"])(
    "作品内の呼称 %s は総称として採る",
    (value) => {
      expect(
        normalizeExtractedAbilitySystem({ abilityTerm: value })?.abilityTerm
      ).toBe(value);
    }
  );
});

describe("境界事例の方針", () => {
  test.each(["剣術", "槍術", "弓術", "遠当て", "雲歩"])(
    "作品が能力と定めた %s は一般的な語でも残す",
    (name) => {
      // 「教科書チート」本文では剣術・槍術・弓術が神術・仙術と並列に
      // 列挙されており、この作品では正式な能力である。
      // 何を能力とするかは作品が決めるため、コードでは判定できない。
      const line = `村では希望者に${name}を教えている`;
      const result = validateExtractedAbilities(
        [{ name, evidence: line }],
        { ...chunk, text: line }
      );

      expect(result.rejected).toEqual([]);
      expect(result.accepted).toHaveLength(1);
    }
  );

  test.each([
    ["石造りの建物", true],
    ["背の高い塔", false],
    ["古い小屋", true],
    ["大きな広場", true],
  ])("情景描写 %s を場所として採らない", (name, shouldReject) => {
    const line = `${name}が見えてきた`;
    const result = validateExtractedLocations(
      [{ name, evidence: line }],
      { ...chunk, text: line }
    );

    if (shouldReject) {
      expect(result.accepted).toEqual([]);
      expect(result.rejected).toEqual([{ name, reason: "not_a_place" }]);
    }
  });

  test.each([
    "冒険者ギルドの二階の事務室",
    "シーゲンの街",
    "コンストラクタ男爵領の村",
    "治療院",
    "死の谷",
  ])("説明的でも特定の場所を指す %s は残す", (name) => {
    const line = `${name}へ向かった`;
    const result = validateExtractedLocations(
      [{ name, evidence: line }],
      { ...chunk, text: line }
    );

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
  });
});
