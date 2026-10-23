import { describe, expect, test } from "vitest";
import {
  changeGroups,
  describeInvolvement,
  scoreCharacterChanges,
  scoreChanges,
  scoreFieldChange,
  stripInvolvementNote,
} from "../../../src/core/changeSignificance";
import { describeCharacter } from "../../../src/core/settingsSummary";
import { emptyCharacter, type Character } from "../../../src/models/character";
import type { RecordChange } from "../../../src/models/jsonValidation";

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
    character.appearedChapters = [1, 5, 9, 11, 12];
    character.changes = [
      change("appearance", "黒髪", [1]),
      change("appearance", "銀髪", [5]),
      change("appearance", "白髪", [9]),
      change("appearance", "赤毛", [11, 12]),
    ];

    // 20（基礎）+ 5（新しい内容を足した話が4つ）+ 10（続いている）
    expect(scoreCharacterChanges(character)[0].score).toBe(35);
  });

  test("3つの話で変わっただけでは、段の加点を付けない（2026-10-17）", () => {
    // 3段から足すと、出来事と細部が足されただけの人物が「高」に残った
    const character = emptyCharacter("char_001", "文佳");
    character.appearedChapters = [1, 5, 9, 12];
    character.changes = [
      change("appearance", "黒髪", [1]),
      change("appearance", "銀髪", [5]),
      change("appearance", "白髪", [9, 12]),
    ];

    // 20（基礎）+ 10（続いている）
    expect(scoreCharacterChanges(character)[0].score).toBe(30);
  });

  test("同じ話の値は、何件あっても1段に数える（2026-10-17）", () => {
    // AIが同じ話の中で同じことを違う言葉で書いた跡を、段に化けさせない
    const character = emptyCharacter("char_001", "文佳");
    character.appearedChapters = [1, 7];
    character.changes = [
      change("role", "新人", [1]),
      change("role", "見習い", [1]),
      change("role", "新入り", [1]),
      change("role", "課長", [7]),
    ];

    // 55（基礎）+ 5（最新の登場話で変わったばかり）。件数の4は段にしない
    expect(scoreCharacterChanges(character)[0].score).toBe(60);
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

  test("末尾に「（高）」だけを写しても落とす（2026-10-15、26b の再読込で3回中3回）", () => {
    expect(
      stripInvolvementNote("B級冒険者。オーク肉を『不死妃の宮』へ納品する役割を担う。（高）")
    ).toBe("B級冒険者。オーク肉を『不死妃の宮』へ納品する役割を担う。");
    expect(stripInvolvementNote("課長。(中)")).toBe("課長。");
    expect(stripInvolvementNote("課長（低） ")).toBe("課長");
  });

  test("文の途中の（高）は落とさない（末尾の印だけを見る）", () => {
    const text = "背が高い（高）身長の男。";
    expect(stripInvolvementNote(text)).toBe(text);
  });

  test("注釈しか無ければ空にする", () => {
    // 空にしておけば、呼び出し側が「値なし」として扱う
    expect(stripInvolvementNote("［関与度 30（低）］")).toBe("");
  });
});

/**
 * 作者の判断例（2026-10-17。docs/measurements/2026-10-17-change-significance-proposal.md）。
 *
 * 作者が役割の関与度を見て「高すぎる」「合っている」と判断した人物を、
 * **作り物の値で同じ形に写した**もの（作者の作品の文は写さない）。
 * 形とは「話でまとめた群がいくつあり、それぞれがどれだけ新しい語を足しているか」
 * である。新しさは先に `changeGroups` の出力で確かめてから点を見る——
 * 作り物の文が狙いどおりの新しさになっていなければ、点が合っても偶然である。
 *
 * - 奥原型・純也型：AIの言い換えで段が増えていた。60未満（「中」）にする
 * - 春原月夜型・三門太志型・ジャック型・圭織型：60以上（「高」）に残す
 * - ホンゴー型：言い換えばかりだが、物語の中心にいる。あらすじの半分以上に
 *   名前が出るか、作者が主人公の印を付けていれば 60 に残る
 */
function roleChanges(groups: Array<[number[], string[]]>): RecordChange[] {
  return groups.flatMap(([chapters, values]) =>
    values.map((value) => change("role", value, chapters))
  );
}

function personWith(
  name: string,
  appearedChapters: number[],
  changes: RecordChange[]
): Character {
  const character = emptyCharacter("char_001", name);
  character.appearedChapters = appearedChapters;
  character.changes = changes;
  return character;
}

function roleScore(
  character: Character,
  context?: Parameters<typeof scoreCharacterChanges>[1]
): number {
  const significance = scoreCharacterChanges(character, context).find(
    (entry) => entry.field === "role"
  );
  if (!significance) throw new Error("役割の関与度が出ていません");
  return significance.score;
}

function novelties(character: Character): number[] {
  return changeGroups(
    character.changes.filter((entry) => entry.field === "role")
  ).map((group) => Math.round(group.novelty * 100) / 100);
}

/** 奥原型：同じ話の言い換えが3件、後の話もその言い換え */
const okuharaLike = () =>
  personWith("奥田", [6, 8, 11], roleChanges([
    [[6], ["盗賊団の見張り役", "盗賊団の下っ端", "村人（隣人）"]],
    [[11], ["盗賊団の下っ端の村人"]],
  ]));

/** 純也型：新しい段は3つ（出来事と細部が足されただけ）。最後は前の値の一部 */
const junyaLike = () =>
  personWith("純一", [6, 7, 8, 10, 12, 15, 18], roleChanges([
    [[6], ["旅の仲間。追われている少年", "少年（同行者）"]],
    [[7], ["呪いをかけられた被害者"]],
    [[8], ["港町の学校の生徒、呪いの被害者"]],
    [[12], ["生徒"]],
  ]));

/** 春原月夜型：同じ話の言い換え3件のあと、最新の登場話で前に無い語を足す */
const tsukiyoLike = () =>
  personWith("春野", [13, 15, 18], roleChanges([
    [[13], ["同じ組の生徒", "学生", "武術を習う小学生"]],
    [[18], ["主人公の幼なじみ"]],
  ]));

/** 三門太志型：本当に変わった段が5つ。最後だけ言い換え */
const futoshiLike = () =>
  personWith("三浦太一", [1, 3, 5, 7, 9, 10], roleChanges([
    [[1], ["火事で亡くなった少年"]],
    [[3], ["少女に生まれ変わった魂"]],
    [[5], ["学生"]],
    [[7], ["少女に宿る霊、旧家の息子"]],
    [[9], ["守護霊として宿る魂"]],
    [[10], ["少女に宿る霊"]],
  ]));

/** ジャック型：短い語での降格は言い換えに見えるが、最新の登場話で新しい役目が付く */
const jackLike = () =>
  personWith("ジョン", [1, 5, 7], roleChanges([
    [[1], ["元一級の騎士"]],
    [[5], ["元一級の騎士。三級"]],
    [[7], ["元一級の騎士。見習いを鍛える教官"]],
  ]));

/** 圭織型：3つの話で、それぞれ新しい関係が足される */
const kaoriLike = () =>
  personWith("香織", [4, 10, 12], roleChanges([
    [[4], ["母親", "主人公の母"]],
    [[10], ["旧家の母親"]],
    [[12], ["霊の母"]],
  ]));

/** ホンゴー型：主人公だが、役割の記録はほぼ言い換え */
const hongoLike = () =>
  personWith("本田", [1, 6, 7, 10, 18], roleChanges([
    [[1], ["役所の窓口係、旅人"]],
    [[6], ["役所の窓口係の職員"]],
    [[7], ["役所の窓口係"]],
    [[10], ["役所の窓口係。旅人"]],
    [[18], ["役所の窓口係"]],
  ]));

describe("作者の判断例（2026-10-17）", () => {
  test("作り物の値が、狙いどおりの新しさになっている", () => {
    expect(novelties(okuharaLike())).toEqual([1, 0.22]);
    expect(novelties(junyaLike())).toEqual([1, 1, 0.77, 0]);
    expect(novelties(tsukiyoLike())).toEqual([1, 1]);
    expect(novelties(futoshiLike())).toEqual([1, 0.9, 1, 0.8, 0.88, 0]);
    expect(novelties(jackLike())).toEqual([1, 0.29, 0.64]);
    expect(novelties(kaoriLike())).toEqual([1, 0.5, 0.5]);
    expect(novelties(hongoLike())).toEqual([1, 0.38, 0, 0, 0]);
  });

  test("奥原型は「高」から外れる（言い換えを段に数えない）", () => {
    expect(roleScore(okuharaLike())).toBeLessThan(60);
  });

  test("純也型は「高」から外れる（新しい段が3つでは加点しない）", () => {
    expect(roleScore(junyaLike())).toBeLessThan(60);
  });

  test("春原月夜型は「高」に残る（最新の登場話で前に無い語を足した）", () => {
    expect(roleScore(tsukiyoLike())).toBe(60);
  });

  test("三門太志型は「高」に残る（本当に変わった段が5つある）", () => {
    expect(roleScore(futoshiLike())).toBe(65);
  });

  test("ジャック型・圭織型は「高」に残る", () => {
    expect(roleScore(jackLike())).toBe(60);
    expect(roleScore(kaoriLike())).toBe(60);
  });

  test("ホンゴー型は、言い換えだけなら「中」", () => {
    expect(roleScore(hongoLike())).toBe(55);
  });

  test("あらすじの半分以上に名前が出る人物は +5", () => {
    const synopses = ["本田が窓口に立つ", "本田が旅に出る", "役所の一日"];

    expect(roleScore(hongoLike(), { synopses })).toBe(60);
  });

  test("あらすじに出るのが半分未満なら足さない", () => {
    const synopses = ["本田が窓口に立つ", "役所の一日", "雨の日"];

    expect(roleScore(hongoLike(), { synopses })).toBe(55);
  });

  test("名前の一部である別名もあらすじで数える", () => {
    // あらすじでは下の名前だけで書かれることが多い
    const character = futoshiLike();
    character.aliases = ["太一", "坊や"];
    const synopses = ["太一が目を覚ます", "太一が学校へ行く", "坊やと呼ばれる"];

    expect(roleScore(character, { synopses })).toBe(70);
    // 「坊や」は名前の一部ではないので数えない
    expect(
      roleScore(character, { synopses: ["坊やと呼ばれる", "坊やが泣く"] })
    ).toBe(65);
  });

  test("作者が主人公の印を付けた人物は +5", () => {
    const character = hongoLike();
    character.isProtagonist = true;

    expect(roleScore(character)).toBe(60);
  });

  test("主人公の印とあらすじが重なれば、+5 を別々に足す（作者の裁定、2026-10-23）", () => {
    // 三門太志は、あらすじの18話中11話に名前が出るので、印を付けても付けなくても
    // 70 のままだった。印を付けた意味が点に出るよう、印の +5 は別に足す
    const character = hongoLike();
    character.isProtagonist = true;
    const synopses = ["本田が窓口に立つ", "本田が旅に出る"];

    expect(roleScore(character, { synopses })).toBe(65);
    const [significance] = scoreCharacterChanges(character, { synopses });
    // 内訳も別々の行に出す（どちらの +5 か作者に見えるように）
    expect(significance.reasons).toContain(
      "作者が主人公（中心人物）の印を付けている +5"
    );
    expect(significance.reasons).toContain(
      "各話あらすじの2話中2話に名前が出る +5"
    );
  });

  test("三門太志型：あらすじでよく出る人物に印を付けると、70 から 75 へ動く（2026-10-23）", () => {
    // 設計書の例（三門太志、18話中11話）。重ねない作りでは、印を付けても 70 のままだった
    const character = futoshiLike();
    character.aliases = ["太一"];
    const synopses = ["太一が目を覚ます", "太一が学校へ行く", "雨の日"];

    expect(roleScore(character, { synopses })).toBe(70);
    character.isProtagonist = true;
    expect(roleScore(character, { synopses })).toBe(75);
  });

  test("印もあらすじも無ければ、人物の加点は付かない", () => {
    const [significance] = scoreCharacterChanges(hongoLike(), {
      synopses: ["役所の一日", "雨の日"],
    });

    expect(significance.score).toBe(55);
    expect(significance.reasons.join("\n")).not.toContain("主人公");
    expect(significance.reasons.join("\n")).not.toContain("あらすじ");
  });

  test("印の +5 とあらすじの +5 は、それぞれ1行ずつ出る（まとめた1行にしない）", () => {
    const character = hongoLike();
    character.isProtagonist = true;
    const [significance] = scoreCharacterChanges(character, {
      synopses: ["本田が窓口に立つ", "本田が旅に出る"],
    });

    const centralityLines = significance.reasons.filter(
      (line) => line.includes("主人公") || line.includes("あらすじ")
    );
    expect(centralityLines).toEqual([
      "作者が主人公（中心人物）の印を付けている +5",
      "各話あらすじの2話中2話に名前が出る +5",
    ]);
  });

  test("両方の +5 で、中から高へ境目をまたぐ（片方だけでは中のまま）", () => {
    // 所属の基礎点 50。変化後が1話だけなので定着の加点は付かない
    const character = personWith("本田", [1, 2, 7, 8, 9], [
      change("affiliation", "役所", [1, 2]),
      change("affiliation", "ギルド", [7]),
    ]);
    const synopses = ["本田が窓口に立つ", "本田が旅に出る"];
    const affiliation = (context?: Parameters<typeof scoreCharacterChanges>[1]) =>
      scoreCharacterChanges(character, context).find(
        (entry) => entry.field === "affiliation"
      );

    expect(affiliation()?.score).toBe(50);
    expect(affiliation({ synopses })?.level).toBe("medium");
    character.isProtagonist = true;
    expect(affiliation()?.score).toBe(55);
    expect(affiliation()?.level).toBe("medium");
    expect(affiliation({ synopses })?.score).toBe(60);
    expect(affiliation({ synopses })?.level).toBe("high");
  });

  test("両方の +5 を足しても 100 で止まる", () => {
    // 役割 55 + 作者が確定 20 + 新しい段5つ 10 + 定着 10 = 95
    const character = personWith("本田", [1, 3, 5, 7, 9, 10, 11], [
      change("role", "見習い", [1], { source: "author" }),
      change("role", "門番", [3]),
      change("role", "騎士団の副長", [5]),
      change("role", "王都の宰相", [7]),
      change("role", "反乱軍の首領", [9, 10, 11]),
    ]);
    const synopses = ["本田が城へ入る", "本田が反旗を翻す"];

    expect(roleScore(character)).toBe(95);
    character.isProtagonist = true;
    expect(roleScore(character, { synopses })).toBe(100);
    // 上限で切っても、内訳には2つの +5 を残す（点が切れた理由を作者が読める）
    const [significance] = scoreCharacterChanges(character, { synopses });
    expect(significance.reasons).toContain(
      "作者が主人公（中心人物）の印を付けている +5"
    );
    expect(significance.reasons).toContain("各話あらすじの2話中2話に名前が出る +5");
  });

  test("あらすじを渡さない材料では、印の +5 だけになる", () => {
    // 矛盾検知・検索の資料などは、あらすじを渡さない（describeCharacter の既定）
    const character = hongoLike();
    character.isProtagonist = true;

    expect(describeCharacter(character)).toContain("関与度 60（高）");
    expect(
      describeCharacter(character, [], {
        synopses: ["本田が窓口に立つ", "本田が旅に出る"],
      })
    ).toContain("関与度 65（高）");
  });

  test("AIへ渡す材料にも、あらすじの加点が入る（画面と同じ数字）", () => {
    const synopses = ["本田が窓口に立つ", "本田が旅に出る"];

    expect(describeCharacter(hongoLike(), [], { synopses })).toContain(
      "関与度 60（高）"
    );
    expect(describeCharacter(hongoLike())).toContain("関与度 55（中）");
  });

  test("重み0の項目は、人物の加点でも押し上げない", () => {
    const character = changed("summary");
    character.isProtagonist = true;

    expect(scoreCharacterChanges(character)[0].score).toBe(0);
  });

  test("群が1つしか無い項目には、定着の加点を付けない", () => {
    // 同じ話の言い換えだけで、話をまたぐ変化が無い。変化した後の姿が無いので、
    // それが根を張っているかを測りようがない
    const character = personWith("三浦", [14, 18], roleChanges([
      [[14], ["亡くなった子ども"]],
      [[14, 18], ["学生"]],
    ]));

    expect(roleScore(character)).toBe(55);
  });
});

/**
 * 作者の判断例（2026-10-18。docs/measurements/2026-10-18-identity-and-significance-proposal.md）。
 *
 * ウィズ型：最新の登場話の値が、前の話までの語（「父」「姿を消した」）を
 * つなぎ直し、短い語（「半年前から」）を足しただけ。新しい語が半分に届かないので
 * 段に数えず、段の +5 も「変わったばかり」の +5 も付かない。作者の判断は「中まで」。
 */
const wizLike = () =>
  personWith("ウォル", [6, 7, 9, 18], roleChanges([
    [[6], ["元二級の狩人（弓）"]],
    [[7], ["元狩人。姿を消した賞金首"]],
    [[9], ["施しを受ける者。リナの父"]],
    [[18], ["リナの父。半年前から姿を消した"]],
  ]));

describe("作者の判断例（2026-10-18）", () => {
  test("作り物の値が、狙いどおりの新しさになっている", () => {
    // 最後の群は 0.4 と 0.5 のあいだ（実データのウィズは 0.47）
    expect(novelties(wizLike())).toEqual([1, 0.9, 1, 0.46]);
  });

  test("ウィズ型は「高」から外れる（前の語を半分以上くり返す話は段に数えない）", () => {
    expect(roleScore(wizLike())).toBe(55);
  });

  test("前の判断例（10-17）の合否は変わらない", () => {
    expect(roleScore(tsukiyoLike())).toBe(60);
    expect(roleScore(okuharaLike())).toBeLessThan(60);
    expect(roleScore(junyaLike())).toBeLessThan(60);
  });
});
