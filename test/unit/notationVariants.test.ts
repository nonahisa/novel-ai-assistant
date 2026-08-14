import { describe, expect, test } from "vitest";
import {
  detectNotationVariants,
  findOccurrences,
  switchKanaScript,
  type NotationSource,
} from "../../src/core/notationVariants";
import { buildUniqueContext } from "../../src/features/checkNotation";

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
