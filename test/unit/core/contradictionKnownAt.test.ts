import { describe, expect, test } from "vitest";
import {
  buildKnownAtIndex,
  lookupSettingKnownAt,
} from "../../../src/core/contradictionValidation";
import {
  contradictionVerifyCacheSource,
  describeKnownAt,
} from "../../../src/core/contradictionAssembly";

/**
 * 確かめの段（P-12b）へ渡す「この設定が分かる話」（設計書6.10.5、2026-10-17）。
 *
 * **再現**：索引は変化の記録の値と `settingSays` が**完全に一致する**ときしか
 * 話数を返さなかった。検出の段は「一人称: ボク」「一人称は「ボク」である。」
 * 「第2話にて「左の足首を折った」と記述されている。」のような文で書くので、
 * 実データではほぼ常に「（不明）」になり、26b が作者の作品の写しの第10話
 * 「わたくし」を「まだ明かされていない」で落とした（10-16 の診断で「第3話」を
 * 渡すと3回とも採用）。一人称は変化の記録に載らないので、値の形をほどいても
 * それだけでは引けない。
 */

/** 写しのエルシーに近い形（一人称は変化の記録に無い） */
const elsie = {
  name: "エルシー",
  aliases: ["エルシーさん"],
  appearedChapters: [3, 5, 10],
  firstPerson: { default: "ボク", variants: [] },
  appearance: "茶髪短髪のエルフ。",
  changes: [{ field: "role", value: "近衛騎士", chapters: [5, 6] }],
};

const ajano = {
  name: "アジャーノ",
  aliases: [],
  appearedChapters: [5, 7],
  firstPerson: {
    default: "俺",
    variants: [{ form: "余", context: null, chapters: [12], evidence: null }],
  },
  changes: [],
};

/** 台Bの相沢に近い形（足首は紹介の変化の記録にだけある） */
const haruto = {
  name: "相沢 春人",
  aliases: ["春人"],
  appearedChapters: [1, 2, 3],
  firstPerson: { default: "俺", variants: [] },
  appearance: "背が高い。右目の下に小さなほくろがある。",
  changes: [
    {
      field: "summary",
      value: "立花郵便局の配達員。十月三日に転んで左の足首を折った。",
      chapters: [2],
    },
  ],
};

describe("検出の段が書いた形のまま、分かる話を引く", () => {
  test("「一人称: ボク」は、変化の記録に無くても人物の初出の話で引ける", () => {
    const index = buildKnownAtIndex([elsie]);
    expect(lookupSettingKnownAt(index, "一人称: ボク")).toEqual([3]);
    expect(describeKnownAt(index, "一人称: ボク")).toBe("第3話");
  });

  test("「一人称は「ボク」である。」の形でも引ける", () => {
    const index = buildKnownAtIndex([elsie]);
    expect(lookupSettingKnownAt(index, "一人称は「ボク」である。")).toEqual([3]);
  });

  test("一人称の使い分けは、その使い分けの話数で引ける", () => {
    const index = buildKnownAtIndex([ajano]);
    expect(lookupSettingKnownAt(index, "一人称は「余」")).toEqual([12]);
  });

  test("変化の記録にある値は、初出ではなく記録の話数が勝つ", () => {
    const index = buildKnownAtIndex([elsie]);
    expect(lookupSettingKnownAt(index, "役割: 近衛騎士")).toEqual([5]);
  });

  test("引用した一部が変化の記録の値に含まれていれば、その話数で引ける", () => {
    const index = buildKnownAtIndex([haruto]);
    expect(
      lookupSettingKnownAt(index, "第2話にて「左の足首を折った」と記述されている。")
    ).toEqual([2]);
  });

  test("本体の値の一部を引用していれば、初出の話で引ける", () => {
    const index = buildKnownAtIndex([haruto]);
    expect(
      lookupSettingKnownAt(index, "設定では「右目の下に小さなほくろがある」となっている。")
    ).toEqual([1]);
  });

  test("頭に持ち主の名前を付けた文（台B の e4b の書き方）でも引ける", () => {
    const index = buildKnownAtIndex([haruto]);
    expect(lookupSettingKnownAt(index, "相沢春人は、右目の下に小さなほくろがある。")).toEqual([1]);
    expect(lookupSettingKnownAt(index, "相沢春人は、左の足首を折った。")).toEqual([2]);
  });

  test("短い値（1〜3字）は、含まれているだけでは引かない", () => {
    // 「俺」を含むだけの文に当たると、どの指摘にも話数が付いてしまう
    const index = buildKnownAtIndex([haruto]);
    expect(lookupSettingKnownAt(index, "俺たちは郵便局に勤めている")).toEqual([]);
  });

  test("文の一部に人物の値（所属など）が含まれるだけなら引かない", () => {
    // 写しの e4b：世界観の報酬の決まりが、所属「冒険者ギルド」の話数で引けていた
    const index = buildKnownAtIndex([
      { name: "おっさん", appearedChapters: [2, 8], affiliation: "冒険者ギルド", changes: [] },
    ]);
    expect(
      lookupSettingKnownAt(
        index,
        "ギルドの報酬体系：冒険者ギルドは報酬の4割を差し引く。そのうち2割が税金、2割が運営費となる。"
      )
    ).toEqual([]);
  });

  test("登場話の記録が無い人の、変化の記録に無い値は登録しない", () => {
    const index = buildKnownAtIndex([
      { ...elsie, appearedChapters: [] },
    ]);
    expect(lookupSettingKnownAt(index, "一人称: ボク")).toEqual([]);
  });

  test("同じ値の人が複数いるときは、名前の出ている人に絞る", () => {
    const index = buildKnownAtIndex([haruto, ajano]);
    expect(lookupSettingKnownAt(index, "アジャーノの一人称は「俺」である。")).toEqual([5]);
  });

  test("名前が無ければ、その話に出ている人に絞る", () => {
    const index = buildKnownAtIndex([haruto, ajano]);
    expect(
      lookupSettingKnownAt(index, "一人称は「俺」", { chapterStart: 7, chapterEnd: 7 })
    ).toEqual([5]);
    expect(
      lookupSettingKnownAt(index, "一人称は「俺」", { chapterStart: 2, chapterEnd: 2 })
    ).toEqual([1]);
  });

  test("どこにも無い値は空", () => {
    const index = buildKnownAtIndex([elsie, haruto]);
    expect(lookupSettingKnownAt(index, "一人称: わたくし")).toEqual([]);
    expect(describeKnownAt(index, "一人称: わたくし")).toBe("");
  });
});

describe("確かめの答えの控えの鍵", () => {
  test("分かる話が空なら、以前の鍵と同じ文字列になる（作者の控えを作り直させない）", () => {
    expect(contradictionVerifyCacheSource("h", 3, "引用", "一人称: ボク", "")).toBe(
      "h:3:引用:一人称: ボク"
    );
  });

  test("分かる話が入れば鍵が変わる（渡す中身が変わるので問い直す）", () => {
    const before = contradictionVerifyCacheSource("h", 3, "引用", "一人称: ボク", "");
    const after = contradictionVerifyCacheSource("h", 3, "引用", "一人称: ボク", "第3話");
    expect(after).not.toBe(before);
  });
});

/**
 * **小さいモデルには、索引の直しを効かせない**（A21 の作者の裁定①、2026-10-19）。
 *
 * **再現**：e4b は「この設定が分かる話」が埋まると、話数を却下の材料に使う。
 * 台Cのほくろの左右（設定「相沢春人は右目の下に小さなほくろがある。」に「第1話」）を
 * 「設定資料（第1話）の情報が古く…」で、ギプスの左右（「第2話」）を「時間の経過による
 * 負傷部位の変化」で落とした（3回のうち2〜3回。直す前は3回とも採用）。
 * 小さいモデルへは、直す前と同じ引き方（変化の記録だけ・値の丸ごと一致）で引く。
 */
describe("小さいモデルには直す前の引き方で渡す", () => {
  test("本体の値（初出の話で補ったもの）には話数を付けない", () => {
    const index = buildKnownAtIndex([haruto]);
    expect(describeKnownAt(index, "相沢春人は右目の下に小さなほくろがある。")).toBe("第1話");
    expect(
      describeKnownAt(index, "相沢春人は右目の下に小さなほくろがある。", undefined, {
        smallModel: true,
      })
    ).toBe("");
  });

  test("変化の記録に無い一人称にも話数を付けない", () => {
    const index = buildKnownAtIndex([elsie]);
    expect(describeKnownAt(index, "一人称: ボク", undefined, { smallModel: true })).toBe("");
  });

  test("文の形のままでは引かない（変化の記録の値と丸ごと一致したときだけ）", () => {
    const index = buildKnownAtIndex([elsie]);
    expect(describeKnownAt(index, "役割: 近衛騎士", undefined, { smallModel: true })).toBe("");
    expect(describeKnownAt(index, "近衛騎士", undefined, { smallModel: true })).toBe(
      "第5話、第6話"
    );
  });
});
