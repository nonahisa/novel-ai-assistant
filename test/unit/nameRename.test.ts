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

  test("旧読み→新読みの対応を作る（既定は無効）", () => {
    // 読みを対応表に入れないと、ルビの base だけが変わって
    // `｜源《さなだ》` という読めない形が残る
    const mapping = buildRenameMapping(
      { name: "真田", reading: "さなだ", aliases: [] },
      "源",
      "げん"
    );
    expect(find(mapping, "さなだ")?.to).toBe("げん");
    expect(find(mapping, "さなだ")?.kind).toBe("reading");
    // 「はな」のような読みは普通名詞と重なる。作者が選んだときだけ動かす
    expect(find(mapping, "さなだ")?.enabled).toBe(false);
  });

  test("読みが無い・変わらないなら読みの対応を作らない", () => {
    const noOld = buildRenameMapping({ name: "真田", aliases: [] }, "源", "げん");
    expect(noOld.filter((entry) => entry.kind === "reading")).toHaveLength(0);

    const noNew = buildRenameMapping(
      { name: "真田", reading: "さなだ", aliases: [] },
      "源"
    );
    expect(noNew.filter((entry) => entry.kind === "reading")).toHaveLength(0);

    const same = buildRenameMapping(
      { name: "真田", reading: "さなだ", aliases: [] },
      "眞田",
      "さなだ"
    );
    expect(same.filter((entry) => entry.kind === "reading")).toHaveLength(0);
  });
});

describe("ルビの読み（設計書6.37.3）", () => {
  const source = { name: "真田", reading: "さなだ", aliases: [] as string[] };

  /** 作者が確認画面で四角を全部押した状態にする */
  function allEnabled(mapping: RenameMappingEntry[]): RenameMappingEntry[] {
    return mapping.map((entry) => ({ ...entry, enabled: Boolean(entry.to) }));
  }

  test("読みも選べば、ルビの中の読みまで変わる", () => {
    const mapping = allEnabled(buildRenameMapping(source, "源", "げん"));
    expect(applyMappingToText("{真田|さなだ}が笑った。", mapping)).toBe(
      "{源|げん}が笑った。"
    );
    expect(applyMappingToText("｜真田《さなだ》が笑った。", mapping)).toBe(
      "｜源《げん》が笑った。"
    );
  });

  test("読みを選ばなければ、base だけが変わる", () => {
    const mapping = buildRenameMapping(source, "源", "げん").map((entry) => ({
      ...entry,
      // 読み以外は作者が選んだことにする（既定では読みだけが外れている）
      enabled: entry.kind !== "reading" && Boolean(entry.to),
    }));
    expect(applyMappingToText("{真田|さなだ}が笑った。", mapping)).toBe(
      "{源|さなだ}が笑った。"
    );
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

describe("人物レコードの入れ子（設計書6.37.3）", () => {
  const mapping: RenameMappingEntry[] = [
    { from: "マルキオ", to: "レオン", kind: "full", enabled: true },
  ];

  /** 他人物が持つ「マルキオへの関係と呼称」。呼び方は authorLocked で守られている */
  function neighbour() {
    return {
      id: "char_002",
      name: "灯",
      relations: [{ name: "マルキオ", relation: "師匠" }],
      addressTerms: [
        {
          targetName: "マルキオ",
          targetId: null,
          authorLocked: true,
          forms: [{ term: "マルキオ様", category: null }],
        },
      ],
    };
  }

  test("他人物の relations と addressTerms の旧名を新名にする", () => {
    // 残すと、相関図に旧名の点線ノード（ゴースト）が出続ける（6.38.5）
    const next = applyMappingToRecord(neighbour(), mapping, {
      applyCharacterLinks: true,
    });
    expect(next.relations[0].name).toBe("レオン");
    expect(next.addressTerms[0].targetName).toBe("レオン");
  });

  test("呼び方そのものと authorLocked は触らない", () => {
    // `forms[].term` は作者が固定した呼び方。当てると作者の指定が壊れる
    const next = applyMappingToRecord(neighbour(), mapping, {
      applyCharacterLinks: true,
    });
    expect(next.addressTerms[0].forms[0].term).toBe("マルキオ様");
    expect(next.addressTerms[0].authorLocked).toBe(true);
  });

  test("指定しなければ入れ子は触らない", () => {
    // 人物以外のレコードにも `relations` という項目はありうる
    const next = applyMappingToRecord(neighbour(), mapping);
    expect(next.relations[0].name).toBe("マルキオ");
    expect(next.addressTerms[0].targetName).toBe("マルキオ");
  });

  test("元のレコードの入れ子も書き換えない", () => {
    const record = neighbour();
    applyMappingToRecord(record, mapping, { applyCharacterLinks: true });
    expect(record.relations[0].name).toBe("マルキオ");
    expect(record.addressTerms[0].targetName).toBe("マルキオ");
  });
});
