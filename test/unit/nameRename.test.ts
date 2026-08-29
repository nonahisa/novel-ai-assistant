import { describe, expect, test } from "vitest";
import {
  applyMappingToRecord,
  applyMappingToText,
  buildRenameMapping,
  planTextReplacements,
  type RenameMappingEntry,
} from "../../src/core/nameRename";

/** 対応表から1件を名指しで取る。並び順にテストを縛らない */
function find(mapping: RenameMappingEntry[], from: string) {
  return mapping.find((entry) => entry.from === from);
}

describe("対応表の初期値（設計書6.37.3）", () => {
  test("フルネーム・姓・名の対応を作る", () => {
    const mapping = buildRenameMapping(
      { name: "マルキオ・イークェス", aliases: [] },
      "レオン・ヴァイス"
    );
    expect(find(mapping, "マルキオ・イークェス")?.to).toBe("レオン・ヴァイス");
    expect(find(mapping, "マルキオ")?.to).toBe("レオン");
    expect(find(mapping, "イークェス")?.to).toBe("ヴァイス");
    expect(find(mapping, "マルキオ")?.kind).toBe("part");
  });

  test("部分の数が合わなければ、部分の対応を作らない", () => {
    // どちらの部分がどこへ行くのかは機械には決められない。推測しない
    const mapping = buildRenameMapping(
      { name: "マルキオ・イークェス", aliases: [] },
      "レオン"
    );
    expect(mapping.filter((entry) => entry.kind === "part")).toHaveLength(0);
    expect(find(mapping, "マルキオ・イークェス")?.to).toBe("レオン");
  });

  test("別名は空のまま（変えない）", () => {
    // 推測で別名を変えない。付け替え先は作者に訊く
    const mapping = buildRenameMapping(
      { name: "マルキオ", aliases: ["マル", "イークェス卿"] },
      "レオン"
    );
    expect(find(mapping, "マル")?.to).toBe("");
    expect(find(mapping, "マル")?.kind).toBe("alias");
    expect(find(mapping, "マル")?.enabled).toBe(false);
  });

  test("2文字以下の名前は一括の既定から外す", () => {
    // 短い名前は普通名詞と重なりやすい。個別確認だけにする
    const mapping = buildRenameMapping({ name: "ミナ", aliases: [] }, "サラ");
    expect(find(mapping, "ミナ")?.enabled).toBe(false);
    expect(find(mapping, "ミナ")?.to).toBe("サラ");
  });

  test("3文字以上は既定で有効", () => {
    const mapping = buildRenameMapping({ name: "アリア", aliases: [] }, "サラ");
    expect(find(mapping, "アリア")?.enabled).toBe(true);
  });

  test("名前が変わらないなら対応を作らない", () => {
    const mapping = buildRenameMapping({ name: "アリア", aliases: [] }, "アリア");
    expect(mapping).toHaveLength(0);
  });
});

describe("本文の置換の計画", () => {
  const mapping: RenameMappingEntry[] = [
    { from: "ミナモト", to: "ミナモリ", kind: "full", enabled: true },
    { from: "ミナ", to: "サラ", kind: "alias", enabled: true },
  ];

  test("長い名前を先に当てる", () => {
    const plan = planTextReplacements("ミナモトとミナ", mapping);
    expect(plan.map((item) => item.target)).toEqual(["ミナモト", "ミナ"]);
    expect(plan.map((item) => item.suggestion)).toEqual(["ミナモリ", "サラ"]);
  });

  test("外した対応と、付け替え先が空の対応は動かさない", () => {
    const plan = planTextReplacements("ミナモトとミナ", [
      { from: "ミナモト", to: "ミナモリ", kind: "full", enabled: false },
      { from: "ミナ", to: "", kind: "alias", enabled: true },
    ]);
    expect(plan).toHaveLength(0);
  });

  test("ルビの中も置き換えの対象にする", () => {
    const plan = planTextReplacements("{マルキオ|まるきお}が笑った。", [
      { from: "マルキオ", to: "レオン", kind: "full", enabled: true },
    ]);
    expect(plan).toHaveLength(1);
    expect(plan[0].line).toBe(1);
  });

  test("同じ行に同じ名前が2回出ても、2件目を1件目の位置に化けさせない", () => {
    // 提案パネルは行の中から original を indexOf で探す（`buildUniqueContext`）
    const plan = planTextReplacements("アリアとアリア", [
      { from: "アリア", to: "サラ", kind: "full", enabled: true },
    ]);
    expect(plan).toHaveLength(2);
    const line = "アリアとアリア";
    expect(line.indexOf(plan[0].original)).toBe(0);
    expect(line.indexOf(plan[1].original)).toBe(3);
  });

  test("理由には何をどう変えるかを書く", () => {
    const [item] = planTextReplacements("ミナモト", mapping);
    expect(item.reason).toBe("名前の付け替え：ミナモト → ミナモリ");
  });

  test("行番号は1始まり", () => {
    const plan = planTextReplacements("一行目\nミナモトが来た", mapping);
    expect(plan[0].line).toBe(2);
  });
});

/**
 * 提案パネルの適用処理（`proposalPanel.ts` の `applyIssue`）を写した手順。
 *
 * **本文を書き換える経路は増やさない**ので、付け替えの指摘は既存の口を
 * そのまま通らなければならない。あちらは1件ごとにファイルを読み直し、
 *
 *   1. その行に `original` がまだ在るか
 *   2. `original` の中の `target` の位置
 *   3. そこを `suggestion` で置き換える
 *
 * の順で当てる。ここで同じ順に当てて、**当て損ねる指摘が無いこと**と、
 * 結果が対応表どおりになることを確かめる。
 */
function applyLikeProposalPanel(
  text: string,
  plan: ReturnType<typeof planTextReplacements>
): { text: string; failed: number } {
  const lines = text.split("\n");
  let failed = 0;

  for (const item of plan) {
    const lineText = lines[item.line - 1];
    // 1. 検知からここまでの間に本文が変わっていないか
    if (lineText === undefined || !lineText.includes(item.original)) {
      failed++;
      continue;
    }
    const originalIndexInLine = lineText.indexOf(item.original);
    const targetIndexInOriginal = item.original.indexOf(item.target);
    if (targetIndexInOriginal === -1) {
      failed++;
      continue;
    }
    const at = originalIndexInLine + targetIndexInOriginal;
    lines[item.line - 1] =
      lineText.slice(0, at) +
      item.suggestion +
      lineText.slice(at + item.target.length);
  }

  return { text: lines.join("\n"), failed };
}

describe("提案パネルの適用経路に、そのまま乗る", () => {
  const mapping: RenameMappingEntry[] = [
    { from: "マルキオ・イークェス", to: "レオン・ヴァイス", kind: "full", enabled: true },
    { from: "マルキオ", to: "レオン", kind: "part", enabled: true },
    { from: "イークェス", to: "ヴァイス", kind: "part", enabled: true },
  ];
  const text = [
    "マルキオ・イークェスが門をくぐった。",
    "「マルキオ」と誰かが呼んだ。",
    "イークェス家の紋章が光る。",
  ].join("\n");

  test("1件ずつの適用（個別確認変換）が全件通る", () => {
    const plan = planTextReplacements(text, mapping);
    const applied = applyLikeProposalPanel(text, plan);
    expect(applied.failed).toBe(0);
  });

  test("まとめて適用した結果が、対応表どおりになる", () => {
    const plan = planTextReplacements(text, mapping);
    // 同じ本文を、こちらの当て方（1回走査）でも作ってみて突き合わせる
    expect(applyLikeProposalPanel(text, plan).text).toBe(
      applyMappingToText(text, mapping)
    );
  });

  test("長いほうを先に当てるので、姓名が二重に置き換わらない", () => {
    const plan = planTextReplacements(text, mapping);
    const applied = applyLikeProposalPanel(text, plan);
    expect(applied.text).toContain("レオン・ヴァイスが門をくぐった。");
    // 「レオン・ヴァイス」が「レオン・ヴァイス・ヴァイス」に化けない
    expect(applied.text).not.toContain("ヴァイス・ヴァイス");
  });

  test("target は必ず original の中にある", () => {
    // 無いと、適用が「指摘の位置を特定できませんでした」で止まる
    for (const item of planTextReplacements(text, mapping)) {
      expect(item.original).toContain(item.target);
    }
  });

  test("まとめて適用の対象から外れない（修正案が空でない）", () => {
    // `applyVisible` は confidence が low か、修正案の無いものを掴まない
    for (const item of planTextReplacements(text, mapping)) {
      expect(item.suggestion).toBeTruthy();
    }
  });

  test("同じ行に2回出ても、両方が正しい位置に当たる", () => {
    const line = "アリアが笑い、アリアが泣いた。";
    const plan = planTextReplacements(line, [
      { from: "アリア", to: "サラ", kind: "full", enabled: true },
    ]);
    const applied = applyLikeProposalPanel(line, plan);
    expect(applied.failed).toBe(0);
    expect(applied.text).toBe("サラが笑い、サラが泣いた。");
  });
});

describe("文字列への当てはめ", () => {
  test("一度置き換えたところは、もう一度見ない", () => {
    // 順に当てると「アリア」が「ミナ」を経て「サラ」まで流れてしまう
    const result = applyMappingToText("アリアとミナ", [
      { from: "アリア", to: "ミナ", kind: "full", enabled: true },
      { from: "ミナ", to: "サラ", kind: "part", enabled: true },
    ]);
    expect(result).toBe("ミナとサラ");
  });

  test("当たらなければそのまま返す", () => {
    expect(
      applyMappingToText("だれも居ない", [
        { from: "アリア", to: "サラ", kind: "full", enabled: true },
      ])
    ).toBe("だれも居ない");
  });
});

describe("レコードへの当てはめ", () => {
  const mapping: RenameMappingEntry[] = [
    { from: "マルキオ", to: "レオン", kind: "full", enabled: true },
  ];

  test("紹介などの文字列項目に当てる", () => {
    const record = {
      id: "char_001",
      name: "マルキオ",
      summary: "マルキオは剣士である",
      aliases: ["マルキオ様"],
    };
    const next = applyMappingToRecord(record, mapping);
    expect(next.summary).toBe("レオンは剣士である");
    expect(next.aliases).toEqual(["レオン様"]);
  });

  test("作者が書いたものは触らない", () => {
    // authorNotes と exportNote は絶対に自動更新しない（CLAUDE.md 規則2）
    const record = {
      id: "char_001",
      name: "マルキオ",
      authorNotes: "マルキオの由来はメモのとおり",
      exportNote: "マルキオは資料にだけ出す",
    };
    const next = applyMappingToRecord(record, mapping);
    expect(next.authorNotes).toBe("マルキオの由来はメモのとおり");
    expect(next.exportNote).toBe("マルキオは資料にだけ出す");
  });

  test("識別子は名前ではないので当てない", () => {
    const record = { id: "char_001", schemaVersion: "0.1", name: "マルキオ" };
    const next = applyMappingToRecord(record, mapping);
    expect(next.id).toBe("char_001");
    expect(next.schemaVersion).toBe("0.1");
  });

  test("本人のレコードは新しい名前と読みにする", () => {
    const record = {
      id: "char_001",
      name: "ミナ",
      reading: "みな",
      aliases: [] as string[],
    };
    // 「ミナ」は2文字なので対応表では無効。それでも本人の名前は変わる
    const next = applyMappingToRecord(
      record,
      [{ from: "ミナ", to: "サラ", kind: "full", enabled: false }],
      { newName: "サラ", newReading: "さら" }
    );
    expect(next.name).toBe("サラ");
    expect(next.reading).toBe("さら");
  });

  test("旧名を別名に残さない", () => {
    // 残すと用語ハイライトが旧名を拾い続ける（設計書6.37.3）
    const record = {
      id: "char_001",
      name: "ミナ",
      aliases: ["ミナ", "ミナちゃん"],
    };
    const next = applyMappingToRecord(record, [], {
      newName: "サラ",
      dropAliases: ["ミナ"],
    });
    expect(next.aliases).toEqual(["ミナちゃん"]);
  });

  test("別名が新しい名前と同じになったら落とす", () => {
    const record = { id: "char_001", name: "マルキオ", aliases: ["マルキオ"] };
    const next = applyMappingToRecord(record, mapping, { newName: "レオン" });
    expect(next.aliases).toEqual([]);
  });

  test("元のレコードは書き換えない", () => {
    const record = { id: "char_001", name: "マルキオ", summary: "マルキオの話" };
    applyMappingToRecord(record, mapping, { newName: "レオン" });
    expect(record.name).toBe("マルキオ");
    expect(record.summary).toBe("マルキオの話");
  });
});
