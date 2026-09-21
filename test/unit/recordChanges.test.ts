import { describe, expect, test } from "vitest";
import {
  applyPromotion,
  changeEntryKey,
  changedFields,
  changesOfField,
  dropChanges,
  isFoldableConflict,
  promoteConflictToChanges,
} from "../../src/core/recordChanges";
import { mergeExtractedCharacters } from "../../src/core/characterMerge";
import { unifyCharacters } from "../../src/core/characterUnify";
import {
  emptyCharacter,
  parseCharacter,
  type Character,
} from "../../src/models/character";
import {
  parseChanges,
  type RecordChange,
  type RecordConflict,
} from "../../src/models/jsonValidation";
import {
  buildCharacterMarkdown,
  describeChangeValues,
} from "../../src/core/settingsMarkdown";
import { describeCharacter } from "../../src/core/settingsSummary";

/** 第1〜3話は黒髪、第7話で銀髪になった人物 */
function withHairConflict(): Character {
  const character = emptyCharacter("char_001", "文佳");
  character.appearance = "黒髪";
  character.conflicts = [
    {
      field: "appearance",
      values: ["黒髪", "銀髪"],
      chapters: [1, 2, 3, 7],
      note: null,
      observations: [
        { value: "黒髪", chapters: [1, 2, 3] },
        { value: "銀髪", chapters: [7] },
      ],
    },
  ];
  return character;
}

describe("食い違いを作中の変化へ移す", () => {
  test("値は両方残り、判断待ちの印だけが外れる", () => {
    const promotion = promoteConflictToChanges(withHairConflict(), "appearance");

    expect(promotion?.conflicts).toEqual([]);
    expect(promotion?.changes.map((change) => change.value)).toEqual([
      "黒髪",
      "銀髪",
    ]);
    expect(promotion?.changes[0].chapters).toEqual([1, 2, 3]);
    expect(promotion?.changes[1].chapters).toEqual([7]);
  });

  test("いちばん後ろの話に出てきた値が「今の値」になる", () => {
    // 残さないと、資料の外見が第1話の姿のままになる
    const promotion = promoteConflictToChanges(withHairConflict(), "appearance");
    expect(promotion?.currentValue).toBe("銀髪");
  });

  test("作者が選んだ「今の値」を優先する", () => {
    const promotion = promoteConflictToChanges(
      withHairConflict(),
      "appearance",
      { currentValue: "黒髪" }
    );
    expect(promotion?.currentValue).toBe("黒髪");
  });

  test("作者が書いた補足を捨てない", () => {
    // 食い違いの補足は値ごとではなく1件に付いている。
    // 移す先が無いからと捨てると、作者が書いた文章が消える
    const character = withHairConflict();
    character.conflicts[0].note = "第7話で染めた";

    const promotion = promoteConflictToChanges(character, "appearance");
    expect(promotion?.changes.map((change) => change.note)).toContain(
      "第7話で染めた"
    );
  });

  test("値ごとの話数が無い古いデータでも移せる", () => {
    const character = emptyCharacter("char_001", "文佳");
    character.appearance = "黒髪";
    character.conflicts = [
      {
        field: "appearance",
        values: ["黒髪", "銀髪"],
        chapters: [],
        note: null,
      },
    ];

    const promotion = promoteConflictToChanges(character, "appearance");
    expect(promotion?.changes.map((change) => change.value)).toEqual([
      "黒髪",
      "銀髪",
    ]);
    // どれにも話数が無ければ「今の値」は決められない。元の値を残す
    expect(promotion?.currentValue).toBeUndefined();
  });

  test("値ごとの記録が一部にしか無くても、全部の値を拾う", () => {
    // 記録のある値だけを移すと、既にあった食い違いが表示から消える
    const character = emptyCharacter("char_001", "文佳");
    character.conflicts = [
      {
        field: "appearance",
        values: ["黒髪", "銀髪", "白髪"],
        chapters: [7],
        note: null,
        observations: [{ value: "銀髪", chapters: [7] }],
      },
    ];

    const promotion = promoteConflictToChanges(character, "appearance");
    const values = promotion?.changes.map((entry) => entry.value) ?? [];
    expect(values).toHaveLength(3);
    expect(values).toContain("黒髪");
    expect(values).toContain("銀髪");
    expect(values).toContain("白髪");
  });

  test("対象の食い違いが無ければ何もしない", () => {
    expect(
      promoteConflictToChanges(emptyCharacter("char_001", "文佳"), "appearance")
    ).toBeUndefined();
  });

  test("並びは古い順。話数の無い値は先に置く", () => {
    const character = withHairConflict();
    character.conflicts[0].observations = [
      { value: "銀髪", chapters: [7] },
      { value: "黒髪", chapters: [] },
    ];

    const promotion = promoteConflictToChanges(character, "appearance");
    expect(promotion?.changes.map((change) => change.value)).toEqual([
      "黒髪",
      "銀髪",
    ]);
  });
});

describe("昇格の結果を人物へ反映する", () => {
  test("項目には最新の値を入れ直す", () => {
    const character = withHairConflict();
    const promotion = promoteConflictToChanges(character, "appearance")!;
    const updated = applyPromotion(character, "appearance", promotion);

    expect(updated.appearance).toBe("銀髪");
    expect(updated.conflicts).toEqual([]);
    expect(changesOfField(updated.changes, "appearance")).toHaveLength(2);
  });

  test("知らない項目名では、項目を触らない", () => {
    // 作者が追加した項目などが混ざっても、既定の項目を壊さない
    const character = withHairConflict();
    character.conflicts = [
      { field: "髪型", values: ["長い", "短い"], chapters: [], note: null },
    ];
    const promotion = promoteConflictToChanges(character, "髪型")!;
    const updated = applyPromotion(character, "髪型", promotion);

    expect(updated.appearance).toBe("黒髪");
    expect(changedFields(updated.changes)).toEqual(["髪型"]);
  });

  test("autoGenerated は変えない", () => {
    // 作者が触ったのは1項目の読み方であって、レコード全体を引き取ったのではない
    const character = withHairConflict();
    const promotion = promoteConflictToChanges(character, "appearance")!;
    expect(applyPromotion(character, "appearance", promotion).autoGenerated).toBe(
      true
    );
  });
});

describe("昇格したあとの再抽出", () => {
  function promoted(): Character {
    const character = withHairConflict();
    const promotion = promoteConflictToChanges(character, "appearance")!;
    return applyPromotion(character, "appearance", promotion);
  }

  test("同じ値がまた出てきても、食い違いを立て直さない", () => {
    // 立て直されると、作者が昇格させたそばから同じ判断を求められる
    const result = mergeExtractedCharacters(
      [promoted()],
      [{ data: { name: "文佳", appearance: "黒髪" }, chapters: [9] }]
    );

    expect(result.characters[0].conflicts).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  test("変化のほうに話数が足され、今の値も動く", () => {
    const result = mergeExtractedCharacters(
      [promoted()],
      [{ data: { name: "文佳", appearance: "黒髪" }, chapters: [9] }]
    );

    const change = result.characters[0].changes.find(
      (entry) => entry.value === "黒髪"
    );
    expect(change?.chapters).toEqual([1, 2, 3, 9]);
    // 第9話は第7話より後なので、今の姿は「黒髪」に戻っている
    expect(result.characters[0].appearance).toBe("黒髪");
  });

  test("知らない値でも、話数が違えば作中の変化として畳む", () => {
    const result = mergeExtractedCharacters(
      [promoted()],
      [{ data: { name: "文佳", appearance: "赤毛" }, chapters: [11] }]
    );

    expect(result.characters[0].conflicts).toEqual([]);
    expect(result.characters[0].appearance).toBe("赤毛");
  });

  test("同じ話の中で矛盾したら、これまでどおり食い違いにする", () => {
    // 「銀髪」は第7話の値。同じ第7話に「赤毛」が出たなら、
    // 作中の変化では説明できないので作者の判断へ回す
    const result = mergeExtractedCharacters(
      [promoted()],
      [{ data: { name: "文佳", appearance: "赤毛" }, chapters: [7] }]
    );

    expect(result.characters[0].conflicts).toHaveLength(1);
    expect(result.characters[0].conflicts[0].values).toContain("赤毛");
    expect(result.characters[0].appearance).toBe("銀髪");
  });
});

describe("自動で畳んでよいかの判定", () => {
  function conflict(
    field: string,
    observations: Array<[string, number[]]>
  ): RecordConflict {
    return {
      field,
      values: observations.map(([value]) => value),
      chapters: [],
      note: null,
      observations: observations.map(([value, chapters]) => ({ value, chapters })),
    };
  }

  test("話数の違う値どうしなら畳む", () => {
    expect(
      isFoldableConflict(conflict("appearance", [["黒髪", [1]], ["銀髪", [7]]]))
    ).toBe(true);
  });

  test("同じ話に両方が出ていたら畳まない", () => {
    // 両方が同時に正しいことはない。作中の変化では説明できない
    expect(
      isFoldableConflict(conflict("appearance", [["黒髪", [7]], ["銀髪", [7]]]))
    ).toBe(false);
  });

  test("話数の分かる値が1つしか無ければ畳まない", () => {
    // 比べる相手がいないと前後を決められず、
    // 作者が手で書いた値をAIの読みで押し流しかねない
    expect(
      isFoldableConflict(conflict("role", [["印章師", []], ["偵察員", [1]]]))
    ).toBe(false);
  });

  test("話数の分からない値が2つあれば畳まない", () => {
    expect(
      isFoldableConflict(
        conflict("summary", [["A", []], ["B", []], ["C", [5]], ["D", [9]]])
      )
    ).toBe(false);
  });

  test("読み仮名は、話数が違っても畳まない", () => {
    // 読みは人物の同定情報で、作中では変わらない。
    // 畳むと「第13話までは『ふとし』だった」という嘘の年表になる
    // （実データで太志と密倉文佳の両方で起きた）
    expect(
      isFoldableConflict(conflict("reading", [["ふとし", [13]], ["たいし", [15]]]))
    ).toBe(false);
  });
});

describe("同一人物をまとめる", () => {
  test("片方にしか無い変化も残す", () => {
    const keep = emptyCharacter("char_001", "文佳");
    keep.changes = [change("appearance", "黒髪", [1])];
    const absorb = emptyCharacter("char_002", "密倉 文佳");
    absorb.changes = [change("appearance", "銀髪", [7])];

    const { unified } = unifyCharacters(keep, absorb);
    expect(unified.changes.map((entry) => entry.value)).toEqual([
      "黒髪",
      "銀髪",
    ]);
  });

  test("同じ変化は1件にまとめ、話数と補足を残す", () => {
    const keep = emptyCharacter("char_001", "文佳");
    keep.changes = [{ ...change("appearance", "黒髪", [1]), note: "地の文" }];
    const absorb = emptyCharacter("char_002", "密倉 文佳");
    absorb.changes = [{ ...change("appearance", "黒髪", [3]), note: "台詞" }];

    const { unified } = unifyCharacters(keep, absorb);
    expect(unified.changes).toHaveLength(1);
    expect(unified.changes[0].chapters).toEqual([1, 3]);
    expect(unified.changes[0].note).toBe("地の文\n台詞");
  });
});

describe("保存と読み込み", () => {
  test("書いて読み直しても変化が失われない", () => {
    const character = withHairConflict();
    const promotion = promoteConflictToChanges(character, "appearance")!;
    const updated = applyPromotion(character, "appearance", promotion);

    const reloaded = parseCharacter(JSON.parse(JSON.stringify(updated)));
    expect(reloaded.changes).toEqual(updated.changes);
  });

  test("古いJSON（changes が無い）でも読める", () => {
    const reloaded = parseCharacter({ id: "char_001", name: "文佳" });
    expect(reloaded.changes).toEqual([]);
  });

  test("source は既定で extracted", () => {
    const parsed = parseChanges([{ field: "appearance", value: "黒髪" }]);
    expect(parsed?.[0]).toMatchObject({
      source: "extracted",
      chapters: [],
      timepointId: null,
    });
  });

  test("知らない source は読み込まずに止める", () => {
    expect(() =>
      parseChanges([{ field: "appearance", value: "黒髪", source: "ai" }])
    ).toThrow(/source/);
  });

  test("値の無い変化は読み込まずに止める", () => {
    expect(() => parseChanges([{ field: "appearance" }])).toThrow(/value/);
  });
});

describe("表示", () => {
  test("食い違いと同じ書き方で並べる", () => {
    expect(
      describeChangeValues([
        change("appearance", "銀髪", [7]),
        change("appearance", "黒髪", [1, 2, 3]),
      ])
    ).toBe("黒髪（第1〜3話）→ 銀髪（第7話）");
  });

  /**
   * 同じ話の同じ値が2件並んでいた（作者の指摘、2026-09-06）。
   * 第1話の「変化」に、紹介・役割・性格がそれぞれ2回ずつ出ていた。
   *
   * **台帳の `changes` は消さない**（追記だけの原則）。読むときに畳む。
   */
  test("同じ話・同じ値が並んでいたら、1件として見せる", () => {
    expect(
      describeChangeValues([
        change("summary", "村の少女", [1]),
        change("summary", "村の少女", [1]),
      ])
    ).toBe("村の少女（第1話）");
  });

  test("値が違えば、どちらも残す", () => {
    expect(
      describeChangeValues([
        change("role", "案内役", [1]),
        change("role", "相棒", [1]),
      ])
    ).toBe("案内役（第1話）→ 相棒（第1話）");
  });

  test("同じ値でも話が違えば残す（戻った、という変化である）", () => {
    expect(
      describeChangeValues([
        change("appearance", "黒髪", [1]),
        change("appearance", "銀髪", [4]),
        change("appearance", "黒髪", [9]),
      ])
    ).toBe("黒髪（第1話）→ 銀髪（第4話）→ 黒髪（第9話）");
  });

  test("話数の無い値は「それ以前」と書く", () => {
    expect(
      describeChangeValues([
        change("appearance", "銀髪", [7]),
        change("appearance", "黒髪", []),
      ])
    ).toBe("黒髪（それ以前）→ 銀髪（第7話）");
  });

  test("設定資料に変化として載る", () => {
    const character = withHairConflict();
    const promotion = promoteConflictToChanges(character, "appearance")!;
    const updated = applyPromotion(character, "appearance", promotion);

    const markdown = buildCharacterMarkdown([updated], { workTitle: "試作" });
    expect(markdown).toContain("**変化（appearance）**");
    expect(markdown).not.toContain("変化かもしれない");
  });

  test("AIへ渡す説明にも変化を含める", () => {
    // 項目の値だけを見せると「今の姿」しか分からず、
    // 過去の話について相談したときに食い違う
    const character = withHairConflict();
    const promotion = promoteConflictToChanges(character, "appearance")!;
    const updated = applyPromotion(character, "appearance", promotion);

    expect(describeCharacter(updated)).toContain(
      "変化（appearance）: 黒髪（第1〜3話）→ 銀髪（第7話）"
    );
  });
});

/**
 * 誤って記録された変化を落とす（作者の裁定、2026-09-21）。
 *
 * 実データ（『教科書チート』のターナ先生）で、抽出が話者を取り違えた。
 * 「**ターナ先生**。魔物の数がちょっと多いようなので…」は呼びかけであり、
 * 話し手は別人である。それを読み違えて、女性の人物の第1話に
 * 「リーダー格の男性。」という変化が3項目ぶん残った。
 * レコード本体は直せても、変化の記録を消す手段がどこにも無かった。
 */
describe("誤って記録された変化を落とす", () => {
  /** ターナ先生の実データと同じ形。第1話が取り違え、第7話が正しい */
  function misreadChanges(): RecordChange[] {
    return [
      change("summary", "リーダー格の男性。仲間を指揮し、リナ救出を依頼する。", [1]),
      change("summary", "学院の教師。生徒を導く。", [7]),
    ];
  }

  test("選んだ変化だけが消え、ほかはそのまま残る", () => {
    const before = misreadChanges();
    const { changes, dropped } = dropChanges(before, [
      changeEntryKey(before[0]),
    ]);

    expect(dropped).toBe(1);
    expect(changes.map((entry) => entry.value)).toEqual([
      "学院の教師。生徒を導く。",
    ]);
    // 元の配列は書き換えない（呼び出し側が保存に失敗しても壊れない）
    expect(before).toHaveLength(2);
  });

  test("落とす対象が無ければ、何も壊さずそのまま返す", () => {
    const before = misreadChanges();
    const { changes, dropped } = dropChanges(before, []);

    expect(dropped).toBe(0);
    expect(changes).toBe(before);
  });

  test("当たらない鍵を渡しても、1件も消えない", () => {
    const before = misreadChanges();
    const { changes, dropped } = dropChanges(before, [
      changeEntryKey(change("summary", "別の作品の値", [1])),
    ]);

    expect(dropped).toBe(0);
    expect(changes).toBe(before);
  });

  test("項目が違えば、同じ値でも落ちない", () => {
    const before = [
      change("role", "リーダー格の男性", [1]),
      change("summary", "リーダー格の男性", [1]),
    ];
    const { changes, dropped } = dropChanges(before, [
      changeEntryKey(before[1]),
    ]);

    expect(dropped).toBe(1);
    expect(changes).toEqual([before[0]]);
  });

  test("同じ値でも、話が違えば落ちない", () => {
    const before = [
      change("appearance", "黒髪", [1]),
      change("appearance", "黒髪", [9]),
    ];
    const { changes, dropped } = dropChanges(before, [
      changeEntryKey(before[0]),
    ]);

    expect(dropped).toBe(1);
    expect(changes).toEqual([before[1]]);
  });

  test("話数の並びが違っても、同じ記録として引き当てる", () => {
    const before = [change("appearance", "黒髪", [3, 1, 2])];
    const { dropped } = dropChanges(before, [
      changeEntryKey(change("appearance", "黒髪", [1, 2, 3])),
    ]);

    expect(dropped).toBe(1);
  });

  /**
   * 値に区切り文字が紛れても取り違えない。
   * 鍵を文字列として分解しない理由がこれである（`dropDiffEntries` と同じ）
   */
  test("値に読点や数字が入っていても、別の記録を巻き込まない", () => {
    const before = [
      change("summary", "村の少女", [1]),
      change("summary", "村の少女 1", [1]),
    ];
    const { changes, dropped } = dropChanges(before, [
      changeEntryKey(before[1]),
    ]);

    expect(dropped).toBe(1);
    expect(changes).toEqual([before[0]]);
  });

  test("同じ話・同じ値が二重に記録されていたら、まとめて落ちる", () => {
    // 画面では1行に畳んで見せている（`describeChangeValues`）。
    // 片方だけ残ると、押したのに消えていないように見える
    const before = [
      change("summary", "村の少女", [1]),
      change("summary", "村の少女", [1]),
      change("summary", "町の少女", [7]),
    ];
    const { changes, dropped } = dropChanges(before, [
      changeEntryKey(before[0]),
    ]);

    expect(dropped).toBe(2);
    expect(changes).toEqual([before[2]]);
  });

  test("その項目の変化を全部落とすこともできる", () => {
    const before = misreadChanges();
    const { changes, dropped } = dropChanges(
      before,
      before.map((entry) => changeEntryKey(entry))
    );

    expect(dropped).toBe(2);
    expect(changes).toEqual([]);
  });

  test("作者が書いた変化も、作者自身の操作なので落とせる", () => {
    const authored: RecordChange = {
      ...change("summary", "作者が書いた値", [1]),
      source: "author",
    };
    const { dropped } = dropChanges([authored], [changeEntryKey(authored)]);

    expect(dropped).toBe(1);
  });
});

function change(field: string, value: string, chapters: number[]): RecordChange {
  return {
    field,
    value,
    chapters,
    timepointId: null,
    note: null,
    evidence: null,
    source: "extracted",
  };
}
