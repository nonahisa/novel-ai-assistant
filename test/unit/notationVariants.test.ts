import { describe, expect, test } from "vitest";
import {
  detectNotationVariants,
  findOccurrences,
  switchKanaScript,
  type NotationSource,
} from "../../src/core/notationVariants";
import { buildUniqueContext } from "../../src/features/checkNotation";
import {
  DIGIT_WIDTH_FULL,
  DIGIT_WIDTH_HALF,
  digitWidthReplacement,
} from "../../src/core/digitWidth";

function source(body: string, startLine = 1, filePath = "C:\\work\\001.txt"): NotationSource {
  return { filePath, body, startLine };
}

function group(
  groups: ReturnType<typeof detectNotationVariants>,
  surface: string
) {
  return groups.find((entry) =>
    entry.forms.some((form) => form.surface === surface)
  );
}

describe("かな⇔漢字の表記ゆれ", () => {
  test("両方の表記が本文に出ていれば組にする", () => {
    const groups = detectNotationVariants(
      [source("良い天気だ。\nこれはよい話だ。")],
      { properNouns: [] }
    );

    const found = group(groups, "良い");
    expect(found).toBeDefined();
    expect(found?.kind).toBe("kana_kanji");
    expect(found?.forms.map((form) => form.surface)).toEqual(["良い", "よい"]);
  });

  test("片方しか使われていなければ組にしない（揺れていない）", () => {
    const groups = detectNotationVariants([source("良い天気だ。良い一日だ。")], {
      properNouns: [],
    });

    expect(group(groups, "良い")).toBeUndefined();
  });

  test("「つよい」の中の「よい」は数えない", () => {
    const groups = detectNotationVariants(
      [source("良い人だ。彼はつよい。よい人だ。")],
      { properNouns: [] }
    );

    const found = group(groups, "よい");
    const kana = found?.forms.find((form) => form.surface === "よい");
    // 「つよい」の1件を除いた1件だけが数えられる
    expect(kana?.occurrences).toHaveLength(1);
  });

  test("出現の多い表記が先頭にくる（揃える先の既定になる）", () => {
    const groups = detectNotationVariants(
      [source("よい。よい。よい。良い。")],
      { properNouns: [] }
    );

    const found = group(groups, "よい");
    expect(found?.forms[0].surface).toBe("よい");
    expect(found?.forms[0].occurrences).toHaveLength(3);
    expect(found?.forms[1].surface).toBe("良い");
  });

  test("揺れの大きい組から先に並べる", () => {
    const groups = detectNotationVariants(
      [
        source(
          "良い。よい。よい。よい。\n綺麗だ。きれいだ。"
        ),
      ],
      { properNouns: [] }
    );

    expect(groups[0].forms[0].surface).toBe("よい");
  });
});

describe("固有名詞のひらがな・カタカナ揺れ", () => {
  test("登録名がカタカナで、本文にひらがな表記が出ていれば組にする", () => {
    const groups = detectNotationVariants(
      [source("ハルトが来た。\nはるとは笑った。")],
      { properNouns: ["ハルト"] }
    );

    const found = group(groups, "ハルト");
    expect(found).toBeDefined();
    expect(found?.kind).toBe("proper_noun");
    // ひらがなはカタカナよりコード順が前なので、並べ替えるとこの順になる
    expect(found?.forms.map((form) => form.surface).sort()).toEqual([
      "はると",
      "ハルト",
    ]);
  });

  test("両方が登録済みなら報告しない（別名として意図的に使い分けている）", () => {
    const groups = detectNotationVariants(
      [source("ハルトが来た。はるとは笑った。")],
      { properNouns: ["ハルト", "はると"] }
    );

    expect(group(groups, "ハルト")).toBeUndefined();
  });

  test("2文字の名前は対象にしない（別の語の一部に当たりやすい）", () => {
    const groups = detectNotationVariants([source("シルとしる。")], {
      properNouns: ["シル"],
    });

    expect(group(groups, "シル")).toBeUndefined();
  });

  test("漢字を含む名前は対象にしない", () => {
    const groups = detectNotationVariants([source("月島灯が来た。")], {
      properNouns: ["月島灯"],
    });

    expect(groups).toHaveLength(0);
  });
});

describe("出現箇所の位置", () => {
  test("startLineを基準に元ファイルの行番号を付ける", () => {
    // 本文が元ファイルの20行目から始まる場合（メタデータヘッダーの分）
    const found = findOccurrences([source("一行目\nよい話", 20)], "よい");

    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(21);
    expect(found[0].column).toBe(0);
  });

  test("同じ行に複数回出てもすべて拾う", () => {
    const found = findOccurrences([source("よい。よい。", 1)], "よい");

    expect(found.map((entry) => entry.column)).toEqual([0, 3]);
  });

  test("複数ファイルをまたいで数える", () => {
    const found = findOccurrences(
      [
        source("よい話", 1, "C:\\work\\001.txt"),
        source("よい話", 1, "C:\\work\\002.txt"),
      ],
      "よい"
    );

    expect(found.map((entry) => entry.filePath)).toEqual([
      "C:\\work\\001.txt",
      "C:\\work\\002.txt",
    ]);
  });
});

describe("適用位置を一意に指せる文脈づくり", () => {
  // 適用処理は行の中から original を indexOf で探すため、
  // 同じ行に同じ語が2回出ると2件目が1件目の位置に化ける。
  // 「先頭から探して確かにこの位置に当たる」文脈を返す必要がある

  test("1回しか出ない語は、その語だけで足りる", () => {
    const context = buildUniqueContext("これはよい話だ。", 3, 2);

    expect(context).toBe("よい");
    expect("これはよい話だ。".indexOf(context)).toBe(3);
  });

  test("同じ行の2件目は、前後を広げて2件目の位置に当たるようにする", () => {
    const lineText = "よい。よい。";
    const context = buildUniqueContext(lineText, 3, 2);

    // 先頭から探して、2件目の開始位置に当たること
    expect(lineText.indexOf(context)).toBe(3 - context.indexOf("よい"));
    expect(context).not.toBe("よい");
  });

  test("直前の1件を書き換えたあとでも、2件目を指したままになる", () => {
    // 「よい。よい。」の1件目を適用すると「良い。よい。」になる。
    // そのあとで2件目の指摘を適用しても、正しい位置に当たること
    const before = "よい。よい。";
    const context = buildUniqueContext(before, 3, 2);
    const after = "良い。よい。";

    const at = after.indexOf(context);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at + context.indexOf("よい")).toBe(3);
  });

  test("3回続いても、それぞれ別の位置を指す", () => {
    const lineText = "よい、よい、よい。";
    const positions = [0, 3, 6].map((column) => {
      const context = buildUniqueContext(lineText, column, 2);
      return lineText.indexOf(context) + context.indexOf("よい");
    });

    expect(positions).toEqual([0, 3, 6]);
  });
});

describe("ひらがなとカタカナの入れ替え", () => {
  test("カタカナをひらがなにする", () => {
    expect(switchKanaScript("ハルト")).toBe("はると");
  });

  test("ひらがなをカタカナにする", () => {
    expect(switchKanaScript("はると")).toBe("ハルト");
  });

  test("長音符はそのまま残す", () => {
    expect(switchKanaScript("カーラーン")).toBe("かーらーん");
  });

  test("漢字が混ざっていたら変換しない", () => {
    expect(switchKanaScript("月島灯")).toBeUndefined();
    expect(switchKanaScript("ハルト君")).toBeUndefined();
  });

  test("ひらがなとカタカナが混ざっていたら変換しない", () => {
    expect(switchKanaScript("ハルと")).toBeUndefined();
  });
});

/**
 * **短いほうが長いほうに含まれる組は、長いほうへ畳む**
 * （作者の実機報告、2026-09-06）。
 *
 * 「おばあさん」の一部を「オバアサン」に変えた本文を検知すると、
 * **「ばあさん ↔ バアサン」（73回/2回）と「おばあさん ↔ オバアサン」
 * （8回/2回）の2組**が並んだ。同じ書き換えなのに2行あるので、
 * 作者にはどちらを選べばよいのか分からない。
 *
 * **消すのではなく、重なりを除いてから数え直す。** 短いほうが単独でも
 * 使われている作品では、その分は本物の揺れである。
 */
describe("重なる組を畳む", () => {
  const NOUNS = ["おばあさん", "ばあさん"];

  test("短い組が長い組に呑まれるなら、長いほうだけを出す", () => {
    const groups = detectNotationVariants(
      [source("おばあさんが笑った。\nオバアサンが立った。")],
      { properNouns: NOUNS }
    );

    expect(groups.map((entry) => entry.label)).toEqual([
      "おばあさん ↔ オバアサン",
    ]);
  });

  test("短い組が単独でも出ていれば、重ならない分だけを残す", () => {
    const groups = detectNotationVariants(
      [
        source(
          [
            "おばあさんが笑った。",
            "オバアサンが立った。",
            "ばあさんが座った。",
            "バアサンが寝た。",
          ].join("\n")
        ),
      ],
      { properNouns: NOUNS }
    );

    const short = group(groups, "ばあさん");
    expect(short).toBeDefined();
    // 「おばあさん」「オバアサン」の中の分は数えない
    expect(
      short?.forms.map((form) => [form.surface, form.occurrences.length])
    ).toEqual([
      ["ばあさん", 1],
      ["バアサン", 1],
    ]);
    // 長いほうはそのまま残る
    expect(group(groups, "おばあさん")).toBeDefined();
  });

  test("含み合わない組どうしは、どちらも残す", () => {
    const groups = detectNotationVariants(
      [source("ハルトが来た。はるとが去った。良い日だ。よい日だ。")],
      { properNouns: ["ハルト"] }
    );

    expect(group(groups, "ハルト")).toBeDefined();
    expect(group(groups, "良い")).toBeDefined();
  });
});

/**
 * 半角の数字を全角へ促す（作者の依頼、2026-09-12）。
 *
 * ほかの組と違って、**全角が1度も出ていなくても組を返す**。「揺れている
 * ものを揃える」のではなく「半角のままなら全角にするよう促す」ためである。
 *
 * **0〜9をまとめて1組にする**（作者の指示、2026-09-12
 * 「1〜9の数字の指摘はまとめてかまいません」）。
 */
describe("半角の数字を全角へ促す", () => {
  /** 数字の組は1つだけ */
  function digitGroup(groups: ReturnType<typeof detectNotationVariants>) {
    return groups.find((entry) => entry.kind === "digit_width");
  }

  test("数字が何種類出ていても、組は1つにまとめる", () => {
    const groups = detectNotationVariants([source("3月5日に2人で")], {
      properNouns: [],
    });

    const digits = groups.filter((entry) => entry.kind === "digit_width");
    expect(digits).toHaveLength(1);
    expect(digits[0].key).toBe("digit_width");
    expect(digits[0].forms.map((form) => form.surface).sort()).toEqual([
      "2",
      "3",
      "5",
    ]);
  });

  test("0 も同じ組に入れる（1つだけ別の組に残さない）", () => {
    const groups = detectNotationVariants([source("0時に集合。3人来た。")], {
      properNouns: [],
    });

    const digits = groups.filter((entry) => entry.kind === "digit_width");
    expect(digits).toHaveLength(1);
    expect(digits[0].forms.map((form) => form.surface).sort()).toEqual([
      "0",
      "3",
    ]);
  });

  test("全角が1度も出ていなくても出す（促すための例外）", () => {
    const groups = detectNotationVariants([source("3月に出た。")], {
      properNouns: [],
    });

    const found = digitGroup(groups);
    expect(found).toBeDefined();
    expect(found?.label).toBe("半角の数字（0〜9）↔ 全角");
    // 出ていない表記は並べない（全角の form は作らない）
    expect(found?.forms.map((form) => form.surface)).toEqual(["3"]);
    expect(found?.forms[0].occurrences).toHaveLength(1);
  });

  test("2文字以上の並びは促さない（縦中横で立つ）", () => {
    const groups = detectNotationVariants([source("2026年の12月")], {
      properNouns: [],
    });

    expect(groups.filter((entry) => entry.kind === "digit_width")).toEqual([]);
  });

  test("型番の数字は促さない", () => {
    const groups = detectNotationVariants([source("F5を押す。A-13の件。")], {
      properNouns: [],
    });

    expect(groups.filter((entry) => entry.kind === "digit_width")).toEqual([]);
  });

  test("全角しか無い本文では出さない（直すものが無い）", () => {
    const groups = detectNotationVariants([source("３月５日に２人で")], {
      properNouns: [],
    });

    expect(groups.filter((entry) => entry.kind === "digit_width")).toEqual([]);
  });

  test("半角と全角が混ざっていれば、1組に両方の form が入る", () => {
    const groups = detectNotationVariants(
      [source("3月に来た。\n３月に帰った。\n５日だけ居た。")],
      { properNouns: [] }
    );

    const found = digitGroup(groups);
    expect(
      found?.forms.map((form) => [form.surface, form.occurrences.length])
    ).toEqual([
      // 直す対象（半角）を先に並べる
      ["3", 1],
      ["３", 1],
      ["５", 1],
    ]);
  });

  test("出現の位置は、その行のその桁を指す", () => {
    const groups = detectNotationVariants([source("　3月5日")], {
      properNouns: [],
    });

    const half = digitGroup(groups)?.forms.find(
      (form) => form.surface === "5"
    );
    expect(half?.occurrences).toHaveLength(1);
    expect(half?.occurrences[0].line).toBe(1);
    expect(half?.occurrences[0].column).toBe(3);
  });

  /**
   * 揃える適用（`proposalPanel.ts`）は、行の中から `original` を探し、
   * その中の `target` を `suggestion` へ置き換える。**1組の中で出現ごとに
   * 置換先が違っても、その1か所だけが変わること**を、適用と同じ手順で
   * 確かめる（本文を書き換える処理は増やさない決まりなので、既存の
   * 経路に載るかどうかが要）。
   */
  test("全角へ揃えると、数字ごとに正しい全角へ変わり、元から全角の箇所は動かない", () => {
    const lineText = "　3月5日に２人で";
    const groups = detectNotationVariants([source(lineText)], {
      properNouns: [],
    });
    const found = digitGroup(groups);
    expect(found).toBeDefined();

    // 「全角に揃える」を選んだときの、出現ごとの置換先
    const planned = found!.forms.flatMap((form) => {
      const to = digitWidthReplacement(form.surface, DIGIT_WIDTH_FULL);
      if (to === undefined) return [];
      return form.occurrences.map((occurrence) => ({
        from: form.surface,
        to,
        column: occurrence.column,
      }));
    });

    // 元から全角の「２」は候補に出ない（直すものが無い）
    expect(planned.map((plan) => [plan.from, plan.to])).toEqual([
      ["3", "３"],
      ["5", "５"],
    ]);

    // 適用と同じ手順（行の中から original を探し、その中の target を置換）
    const applied = planned.map((plan) => {
      const original = buildUniqueContext(lineText, plan.column, 1);
      const at = lineText.indexOf(original) + original.indexOf(plan.from);
      return (
        lineText.slice(0, at) + plan.to + lineText.slice(at + plan.from.length)
      );
    });

    expect(applied).toEqual(["　３月5日に２人で", "　3月５日に２人で"]);
  });

  test("半角に揃えるときは、全角の出現だけが対象になる", () => {
    const groups = detectNotationVariants([source("3月と５日")], {
      properNouns: [],
    });

    const planned = digitGroup(groups)!.forms.flatMap((form) => {
      const to = digitWidthReplacement(form.surface, DIGIT_WIDTH_HALF);
      return to === undefined ? [] : [[form.surface, to]];
    });

    expect(planned).toEqual([["５", "5"]]);
  });
});

describe("全角側も、単独の1文字だけを拾う（0.49.4 の検収）", () => {
  /**
   * 半角側は縦中横の規則で1文字の並びだけに絞っているのに、
   * 全角側だけ素の部分一致だった。「半角に揃える」を選んだときに、
   * 年号の途中の1文字が候補に並ぶ。
   */
  function digitGroup(body: string) {
    const groups = detectNotationVariants(
      [{ filePath: "C:/w/001.txt", body, startLine: 1 }],
      { properNouns: [] }
    );
    return groups.find((group) => group.kind === "digit_width");
  }

  test("**全角の連番の中の1文字は拾わない**", () => {
    // 「２０２６年に3人」——半角の3は拾い、全角の２０２６は拾わない
    const group = digitGroup("２０２６年に3人が来た。");

    expect(group).toBeDefined();
    const surfaces = group!.forms.map((form) => form.surface);
    expect(surfaces).toContain("3");
    expect(surfaces).not.toContain("２");
    expect(surfaces).not.toContain("０");
    expect(surfaces).not.toContain("６");
  });

  test("単独の全角数字は拾う", () => {
    const group = digitGroup("３月に5人が来た。");

    expect(group).toBeDefined();
    const surfaces = group!.forms.map((form) => form.surface);
    expect(surfaces).toContain("5");
    expect(surfaces).toContain("３");
  });

  test("全角の型番（Ａ１）も拾わない", () => {
    const group = digitGroup("型番はＡ１で、7個ある。");

    expect(group).toBeDefined();
    const surfaces = group!.forms.map((form) => form.surface);
    expect(surfaces).toContain("7");
    expect(surfaces).not.toContain("１");
  });
});
