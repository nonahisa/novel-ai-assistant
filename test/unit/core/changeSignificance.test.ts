import { describe, expect, test } from "vitest";
import {
  describeInvolvement,
  scoreCharacterChanges,
  scoreChanges,
  scoreFieldChange,
  stripInvolvementNote,
} from "../../src/core/changeSignificance";
import { describeCharacter } from "../../src/core/settingsSummary";
import { emptyCharacter, type Character } from "../../src/models/character";
import type { RecordChange } from "../../src/models/jsonValidation";

/**
 * 変化の関与度（2026-08-26）。
 *
 * 紹介は80字しかない。「課長になった」と「髪を切った」が同じ形で並んでいると、
 * AIは書きやすいほうから埋める。**紙幅を何に使うかをコード側で決める**ための点数で、
 * ここが狂うと紹介の中身が変わる。
 */

function change(
  field: string,
  value: string,
  chapters: number[],
  extra: Partial<RecordChange> = {}
): RecordChange {
  return {
    field,
    value,
    chapters,
    timepointId: null,
    note: null,
    evidence: null,
    source: "extracted",
    ...extra,
  };
}

/** 2段に変わり、変化後が2話以上続いている人物 */
function changed(field: string, extra: Partial<RecordChange> = {}): Character {
  const character = emptyCharacter("char_001", "文佳");
  character.appearedChapters = [1, 2, 3, 7, 8];
  character.changes = [
    change(field, "前の値", [1, 2, 3]),
    change(field, "後の値", [7, 8], extra),
  ];
  return character;
}

describe("関与度の点数", () => {
  test("役割の変化は高い", () => {
    const [significance] = scoreCharacterChanges(changed("role"));

    // 55（基礎）+ 10（2話以上続いている）
    expect(significance.score).toBe(65);
    expect(significance.level).toBe("high");
  });

  test("外見の変化は低い", () => {
    // 髪を切っても話の筋は動かない。紹介の80字は他に使う
    const [significance] = scoreCharacterChanges(changed("appearance"));

    expect(significance.score).toBe(30);
    expect(significance.level).toBe("low");
  });

  test("作者が確定させた変化は、外見でも紹介の候補まで上がる", () => {
    // 作者が自分で「これは作中で変わったのだ」と決めたということは、
    // その変化を見て判断している。機械の重み付けより作者の手を優先する
    const [significance] = scoreCharacterChanges(
      changed("appearance", { source: "author" })
    );

    expect(significance.score).toBe(50);
    expect(significance.level).toBe("medium");
  });

  test("作者が補足を書いた変化も同じ扱いにする", () => {
    const [significance] = scoreCharacterChanges(
      changed("appearance", { note: "呪いが解けた" })
    );

    expect(significance.score).toBe(50);
  });

  test("紹介そのものの変化は、紹介に書かない", () => {
    // 紹介に「紹介が変わった」とは書けない
    const [significance] = scoreCharacterChanges(changed("summary"));

    expect(significance.score).toBe(0);
    expect(significance.level).toBe("low");
  });

  test("読み仮名の変化は、紹介に書かない", () => {
    // 作中で変わらない項目なので、値が割れていたらAIの読み違いである
    // （`recordChanges.ts` の UNCHANGING_FIELDS と揃える）
    const [significance] = scoreCharacterChanges(
      changed("reading", { source: "author" })
    );

    expect(significance.score).toBe(0);
  });

  test("何度も変わっている項目は上がる", () => {
    const character = emptyCharacter("char_001", "文佳");
    character.appearedChapters = [1, 5, 9, 12];
    character.changes = [
      change("appearance", "黒髪", [1]),
      change("appearance", "銀髪", [5]),
      change("appearance", "白髪", [9, 12]),
    ];

    // 20（基礎）+ 5（3段）+ 10（続いている）
    expect(scoreCharacterChanges(character)[0].score).toBe(35);
  });

  test("いちばん新しい登場話で変わったばかりなら、半分だけ足す", () => {
    // まだ2話ぶん書かれていないだけで、それが今の姿である
    const character = emptyCharacter("char_001", "文佳");
    character.appearedChapters = [1, 2, 7];
    character.changes = [
      change("role", "新人", [1, 2]),
      change("role", "課長", [7]),
    ];

    expect(scoreCharacterChanges(character)[0].score).toBe(60);
  });

  test("一度きりで、その後も書かれていない変化は足さない", () => {
    // 変装や一時的な立場かもしれない
    const character = emptyCharacter("char_001", "文佳");
    character.appearedChapters = [1, 2, 7, 8, 9];
    character.changes = [
      change("role", "新人", [1, 2]),
      change("role", "代理", [7]),
    ];

    expect(scoreCharacterChanges(character)[0].score).toBe(55);
  });

  test("100を超えない", () => {
    const character = emptyCharacter("char_001", "文佳");
    character.appearedChapters = [1, 3, 5, 7, 9];
    character.changes = [
      change("role", "一", [1], { source: "author" }),
      change("role", "二", [3]),
      change("role", "三", [5]),
      change("role", "四", [7, 9]),
    ];

    expect(scoreCharacterChanges(character)[0].score).toBeLessThanOrEqual(100);
  });

  test("点の内訳を残す", () => {
    // 作者へ「なぜその点なのか」を示せないと、紹介に載らない理由も説明できない
    const [significance] = scoreCharacterChanges(changed("role"));

    expect(significance.reasons.length).toBeGreaterThan(0);
    expect(significance.reasons[0]).toContain("55");
  });
});

describe("並べ方", () => {
  test("関与度の高い順に並べる", () => {
    // AIは先に読んだものを重く扱う。材料の順番がそのまま紹介の書き出しに出る
    const character = emptyCharacter("char_001", "文佳");
    character.appearedChapters = [1, 2, 7, 8];
    character.changes = [
      change("appearance", "黒髪", [1, 2]),
      change("appearance", "銀髪", [7, 8]),
      change("role", "新人", [1, 2]),
      change("role", "課長", [7, 8]),
    ];

    expect(scoreCharacterChanges(character).map((s) => s.field)).toEqual([
      "role",
      "appearance",
    ]);
  });

  test("値が1つしか無い項目は変化として数えない", () => {
    // 空欄を埋めたときにも履歴を残しているので、そのまま並べると
    // 変わっていない項目まで「変化」になる（`changedFields` と揃える）
    const character = emptyCharacter("char_001", "文佳");
    character.changes = [change("role", "課長", [1])];

    expect(scoreCharacterChanges(character)).toEqual([]);
  });

  test("記録が無ければ何も返さない", () => {
    expect(scoreChanges([])).toEqual([]);
  });

  test("知らない項目にも点を付ける", () => {
    // 作者が足した項目（custom_fields.json）が変化として記録されうる。
    // 0にすると、作者が足した項目だけが黙って無視される
    const significance = scoreFieldChange(
      [change("好きな食べ物", "餡蜜", [1]), change("好きな食べ物", "羊羹", [7, 8])],
      "好きな食べ物"
    );

    expect(significance.score).toBe(40);
    expect(significance.level).toBe("medium");
  });
});

describe("表示の書き方", () => {
  test("画面とAIへの材料で、同じ書き方にする", () => {
    const [significance] = scoreCharacterChanges(changed("role"));

    expect(describeInvolvement(significance)).toBe("関与度 65（高）");
  });

  test("AIへ渡す材料に関与度が付く", () => {
    const material = describeCharacter(changed("role"));

    expect(material).toContain("変化（role）: 前の値（第1〜3話）→ 後の値（第7、8話）");
    expect(material).toContain("関与度 65（高）");
  });

  test("関与度の低い変化も、材料からは落とさない", () => {
    // 相談（P-18）ではどれも事実である。ふるいにかけると
    // 「髪を切った話」を聞かれたときに答えられなくなる
    const material = describeCharacter(changed("appearance"));

    expect(material).toContain("変化（appearance）");
    expect(material).toContain("関与度 30（低）");
  });
});

describe("AIが注釈を書き写してきたとき", () => {
  // 指示語がそのまま答えの中身として返るのは、この作品で繰り返し起きている
  test("角括弧ごと落とす", () => {
    expect(
      stripInvolvementNote("生活保護課のケースワーカー。第7話から課長。［関与度 65（高）］")
    ).toBe("生活保護課のケースワーカー。第7話から課長。");
  });

  test("半角の角括弧でも落とす", () => {
    expect(stripInvolvementNote("課長。[関与度 65（高）]")).toBe("課長。");
  });

  test("括弧が無くても落とす", () => {
    expect(stripInvolvementNote("課長。関与度 65（高）")).toBe("課長。");
  });

  test("本文は削らない", () => {
    const text = "冒険者ギルドの生活保護課ケースワーカー。転移者で制度の考案者。";

    expect(stripInvolvementNote(text)).toBe(text);
  });

  test("注釈しか無ければ空にする", () => {
    // 空にしておけば、呼び出し側が「値なし」として扱う
    expect(stripInvolvementNote("［関与度 30（低）］")).toBe("");
  });
});
