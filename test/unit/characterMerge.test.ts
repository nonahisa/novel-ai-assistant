import { describe, expect, test, vi } from "vitest";
import { mergeExtractedCharacters } from "../../src/core/characterMerge";
import { emptyCharacter } from "../../src/models/character";

describe("登場人物マージ", () => {
  test("空白だけの人物名は新規人物として保存しない", () => {
    const result = mergeExtractedCharacters([], [
      { data: { name: "   " }, chapters: [1] },
    ]);

    expect(result.characters).toEqual([]);
    expect(result.changedIds).toEqual([]);
  });

  test("入力人物と作者項目を一切変更しない", () => {
    const existing = emptyCharacter("char_001", "灯");
    existing.authorNotes = "作者メモ";
    existing.exportNote = "公開用注記";
    existing.firstPerson.default = "僕";
    const before = structuredClone(existing);

    const result = mergeExtractedCharacters([existing], [
      { data: { name: "灯", firstPerson: "俺" }, chapters: [2] },
    ]);

    expect(existing).toEqual(before);
    expect(result.characters[0]).toMatchObject({
      authorNotes: "作者メモ",
      exportNote: "公開用注記",
    });
  });

  test("姓名と一意な名だけの呼称を同一人物にする", () => {
    const result = mergeExtractedCharacters(
      [emptyCharacter("char_001", "黒木 玲司")],
      [{ data: { name: "玲司さん" }, chapters: [2] }]
    );

    expect(result.characters).toHaveLength(1);
  });

  test("既存が名だけで抽出が姓名でも同一人物にする", () => {
    const result = mergeExtractedCharacters(
      [emptyCharacter("char_001", "玲司")],
      [{ data: { name: "黒木 玲司" }, chapters: [2] }]
    );

    expect(result.characters).toHaveLength(1);
    expect(result.characters[0].aliases).toContain("黒木 玲司");
  });

  test("既存の名だけ候補が複数なら抽出姓名を自動統合しない", () => {
    const first = emptyCharacter("char_001", "玲司");
    const second = emptyCharacter("char_002", "玲司");

    const result = mergeExtractedCharacters(
      [first, second],
      [{ data: { name: "黒木 玲司" }, chapters: [2] }]
    );

    expect(result.characters).toHaveLength(3);
  });

  test("同一入力の新規人物マージは時刻が変わっても完全に同じ結果を返す", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-07T00:00:00.000Z"));
      const first = mergeExtractedCharacters([], [
        { data: { name: "灯", evidence: "灯は歩いた" }, chapters: [1] },
      ]);
      vi.setSystemTime(new Date("2026-08-08T00:00:00.000Z"));
      const second = mergeExtractedCharacters([], [
        { data: { name: "灯", evidence: "灯は歩いた" }, chapters: [1] },
      ]);

      expect(second).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  });

  test("同じ名部分を持つ候補が複数なら自動統合しない", () => {
    const blackReiji = emptyCharacter("char_001", "黒木 玲司");
    const whiteReiji = emptyCharacter("char_002", "白木・玲司");

    const result = mergeExtractedCharacters(
      [blackReiji, whiteReiji],
      [{ data: { name: "玲司さん" }, chapters: [2] }]
    );

    expect(result.characters).toHaveLength(3);
  });

  test("品質fixtureの同名別人へ名だけの蓮を根拠なく割り当てない", () => {
    const result = mergeExtractedCharacters(
      [
        emptyCharacter("char_001", "南条 蓮"),
        emptyCharacter("char_002", "北見 蓮"),
      ],
      [{ data: { name: "蓮" }, chapters: [7] }]
    );

    expect(result.characters).toHaveLength(3);
    expect(result.characters[0].appearedChapters).toEqual([]);
    expect(result.characters[1].appearedChapters).toEqual([]);
  });

  test("完全一致する名前の候補が複数なら自動統合しない", () => {
    const first = emptyCharacter("char_001", "玲司");
    const second = emptyCharacter("char_002", "玲司");

    const result = mergeExtractedCharacters(
      [first, second],
      [{ data: { name: "玲司", role: "騎士" }, chapters: [2] }]
    );

    expect(result.characters).toHaveLength(3);
    expect(result.characters[0].appearedChapters).toEqual([]);
    expect(result.characters[1].appearedChapters).toEqual([]);
  });

  test("完全一致する別名の候補が複数なら自動統合しない", () => {
    const first = emptyCharacter("char_001", "黒木");
    first.aliases = ["玲司"];
    const second = emptyCharacter("char_002", "白木");
    second.aliases = ["玲司"];

    const result = mergeExtractedCharacters(
      [first, second],
      [{ data: { name: "玲司" }, chapters: [2] }]
    );

    expect(result.characters).toHaveLength(3);
    expect(result.characters[0].appearedChapters).toEqual([]);
    expect(result.characters[1].appearedChapters).toEqual([]);
  });

  test("区切りのない部分一致では同一人物にしない", () => {
    const result = mergeExtractedCharacters(
      [emptyCharacter("char_001", "黒木玲司")],
      [{ data: { name: "玲司" }, chapters: [2] }]
    );

    expect(result.characters).toHaveLength(2);
  });

  test("敬称違いを同一人物として扱い、呼び名を別名に残す", () => {
    const existing = emptyCharacter("char_001", "シル");
    const result = mergeExtractedCharacters([existing], [
      { data: { name: "シルさん", aliases: [] }, chapters: [2] },
    ]);

    expect(result.characters).toHaveLength(1);
    expect(result.characters[0].aliases).toContain("シルさん");
    expect(result.characters[0].appearedChapters).toEqual([2]);
  });

  test("抽出した別名と未設定の人物情報を既存人物へ追記する", () => {
    const existing = emptyCharacter("char_001", "灯");

    const result = mergeExtractedCharacters([existing], [{
      data: {
        name: "灯",
        aliases: ["あかり", "灯", "あかり"],
        role: "主人公",
        personality: "冷静",
        appearance: "黒髪",
        firstPerson: "私",
        defaultSecondPerson: "あなた",
        addressTerms: [{ targetName: "", term: "澪さん" }],
        relations: [{ name: "澪", relation: "" }],
        evidence: "灯は歩いた",
      },
      chapters: [1],
    }]);

    expect(result.characters[0]).toMatchObject({
      aliases: ["あかり"],
      role: "主人公",
      personality: "冷静",
      appearance: "黒髪",
      firstPerson: { default: "私", variants: [] },
      defaultSecondPerson: "あなた",
      addressTerms: [],
      relations: [],
      evidence: "灯は歩いた",
    });
  });

  test("作者確定済み人物は本文登場話だけを追記する", () => {
    const existing = emptyCharacter("char_001", "灯");
    existing.autoGenerated = false;
    existing.personality = "作者が確定した性格";
    existing.authorNotes = "変更禁止";

    const result = mergeExtractedCharacters([existing], [
      {
        data: { name: "灯", personality: "AIの別解" },
        chapters: [3],
      },
    ]);

    expect(result.characters[0].personality).toBe("作者が確定した性格");
    expect(result.characters[0].authorNotes).toBe("変更禁止");
    expect(result.characters[0].appearedChapters).toEqual([3]);
  });

  test("作者がロックした呼称を変更しない", () => {
    const existing = emptyCharacter("char_001", "灯");
    existing.addressTerms = [{
      targetName: "澪",
      targetId: "char_002",
      authorLocked: true,
      forms: [{
        term: "澪さん",
        category: "名前+敬称",
        context: "作者設定",
        firstChapter: 1,
        lastChapter: 1,
        status: "current",
        evidence: "作者記述",
      }],
    }];

    const result = mergeExtractedCharacters([existing], [{
      data: {
        name: "灯",
        addressTerms: [{ targetName: "澪", term: "澪" }],
      },
      chapters: [2],
    }]);

    expect(result.characters[0].addressTerms[0].forms).toHaveLength(1);
    expect(result.characters[0].addressTerms[0].forms[0].term).toBe("澪さん");
  });

  test("異なる一人称を変化形として話数付きで残す", () => {
    const existing = emptyCharacter("char_001", "灯");
    existing.firstPerson.default = "僕";

    const result = mergeExtractedCharacters([existing], [
      { data: { name: "灯", firstPerson: "俺", evidence: "俺が行く" }, chapters: [3, 5] },
    ]);

    expect(result.characters[0].firstPerson).toEqual({
      default: "僕",
      variants: [{ form: "俺", context: null, chapters: [3, 5], evidence: "俺が行く" }],
    });
  });

  test("既存の一人称変化形と同じ抽出結果を重複して追加しない", () => {
    const existing = emptyCharacter("char_001", "灯");
    existing.appearedChapters = [2];
    existing.firstPerson.default = "僕";
    existing.firstPerson.variants = [{
      form: "俺",
      context: null,
      chapters: [2],
      evidence: "俺が行く",
    }];

    const result = mergeExtractedCharacters([existing], [
      { data: { name: "灯", firstPerson: "俺" }, chapters: [2] },
    ]);

    expect(result.characters[0].firstPerson.variants).toHaveLength(1);
    expect(result.changedIds).toEqual([]);
  });

  test("同じ呼称の初出・最終話と空だった文脈を更新する", () => {
    const existing = emptyCharacter("char_001", "灯");
    existing.addressTerms = [{
      targetName: "澪",
      targetId: null,
      authorLocked: false,
      forms: [{
        term: "澪さん",
        category: null,
        context: null,
        firstChapter: 3,
        lastChapter: 3,
        status: "current",
        evidence: null,
      }],
    }];

    const result = mergeExtractedCharacters([existing], [{
      data: {
        name: "灯",
        addressTerms: [{ targetName: "澪", term: "澪さん", context: "平時" }],
      },
      chapters: [1, 5],
    }]);

    expect(result.characters[0].addressTerms[0].forms[0]).toMatchObject({
      firstChapter: 1,
      lastChapter: 5,
      context: "平時",
    });
  });

  test("既存記述と食い違う情報を上書きせず競合に残す", () => {
    const existing = emptyCharacter("char_001", "灯");
    existing.role = "騎士";

    const result = mergeExtractedCharacters([existing], [
      { data: { name: "灯", role: "魔術師" }, chapters: [2] },
    ]);

    expect(result.characters[0].role).toBe("騎士");
    expect(result.conflicts).toEqual([
      { characterName: "灯", field: "role", values: ["騎士", "魔術師"] },
    ]);
  });

  test("詳細な記述を採用し既存の競合候補を重複なく追加する", () => {
    const existing = emptyCharacter("char_001", "灯");
    existing.role = "騎士";
    existing.personality = "冷静で慎重";
    existing.appearance = "黒髪";
    existing.conflicts = [{
      field: "appearance",
      values: ["黒髪", "銀髪"],
      chapters: [1],
      note: null,
    }];

    const first = mergeExtractedCharacters([existing], [{
      data: {
        name: "灯",
        role: "王都を守る騎士",
        personality: "冷静",
        appearance: "赤髪",
      },
      chapters: [2],
    }]);
    const second = mergeExtractedCharacters(first.characters, [{
      data: { name: "灯", appearance: "赤髪" },
      chapters: [2],
    }]);

    expect(first.characters[0]).toMatchObject({
      role: "王都を守る騎士",
      personality: "冷静で慎重",
    });
    expect(first.characters[0].conflicts[0].values).toEqual([
      "黒髪",
      "銀髪",
      "赤髪",
    ]);
    expect(second.changedIds).toEqual([]);
  });

  test("全角数字と半角数字の表記違いを同一人物として扱う", () => {
    const result = mergeExtractedCharacters(
      [emptyCharacter("char_001", "衛兵１")],
      [{ data: { name: "衛兵1" }, chapters: [2] }]
    );

    expect(result.characters).toHaveLength(1);
    expect(result.characters[0].aliases).toContain("衛兵1");
  });

  test("同じ関係を重複して追加しない", () => {
    const existing = emptyCharacter("char_001", "灯");
    const extracted = {
      data: { name: "灯", relations: [{ name: "澪", relation: "友人" }] },
      chapters: [2],
    };

    const result = mergeExtractedCharacters([existing], [extracted, extracted]);

    expect(result.characters[0].relations).toEqual([{ name: "澪", relation: "友人" }]);
  });

  test("有限の話数だけを保存する", () => {
    const existing = emptyCharacter("char_001", "灯");
    existing.firstPerson.default = "僕";

    const result = mergeExtractedCharacters([existing], [
      {
        data: {
          name: "灯",
          firstPerson: "俺",
          addressTerms: [{ targetName: "澪", term: "澪さん" }],
        },
        chapters: [5, 2, Number.NaN, Number.POSITIVE_INFINITY],
      },
    ]);

    expect(result.characters[0].appearedChapters).toEqual([2, 5]);
    expect(result.characters[0].firstPerson.variants[0].chapters).toEqual([5, 2]);
    expect(result.characters[0].addressTerms[0].forms[0]).toMatchObject({
      firstChapter: 2,
      lastChapter: 5,
    });
  });

  test("複数話の呼称に最初と最後の話数を保存する", () => {
    const result = mergeExtractedCharacters([emptyCharacter("char_001", "灯")], [{
      data: {
        name: "灯",
        addressTerms: [{ targetName: "澪", term: "澪さん" }],
      },
      chapters: [5, 2, 4],
    }]);

    expect(result.characters[0].addressTerms[0].forms[0]).toMatchObject({
      firstChapter: 2,
      lastChapter: 5,
    });
  });

  test("実際に変更された人物IDだけを返す", () => {
    const changed = emptyCharacter("char_001", "灯");
    const untouched = emptyCharacter("char_002", "澪");

    const result = mergeExtractedCharacters([changed, untouched], [
      { data: { name: "灯" }, chapters: [4] },
    ]);

    expect(result.changedIds).toEqual(["char_001"]);
  });

  test("既存と同じ抽出結果では変更IDを返さない", () => {
    const existing = emptyCharacter("char_001", "灯");
    existing.appearedChapters = [4];

    const result = mergeExtractedCharacters([existing], [
      { data: { name: "灯" }, chapters: [4] },
    ]);

    expect(result.changedIds).toEqual([]);
  });

  test("AIが集団と判定した新規人物をモブとして保存する", () => {
    const result = mergeExtractedCharacters([], [
      {
        data: { name: "取調官たち", aliases: [], isMob: true },
        chapters: [1],
      },
    ]);

    expect(result.characters[0].isMob).toBe(true);
  });
});

describe("省略形の統合候補", () => {
  function merge(names: string[]) {
    return mergeExtractedCharacters(
      [],
      names.map((name) => ({ data: { name }, chapters: [1] }))
    );
  }

  test("カタカナの省略形を候補として挙げる", () => {
    const result = merge(["ギルドマスター", "ギルマス"]);

    // 自動では統合しない。作者が判断できるよう候補として出すだけ
    expect(result.characters).toHaveLength(2);
    expect(result.mergeCandidates).toEqual([
      { names: ["ギルドマスター", "ギルマス"], reason: "abbreviation" },
    ]);
  });

  test("頭文字が違う語は候補にしない", () => {
    const result = merge(["ギルドマスター", "マスター"]);

    expect(result.mergeCandidates).toEqual([]);
  });

  test("部分列でない語は候補にしない", () => {
    // グランス と グラックス は先頭が同じだが省略関係ではない
    const result = merge(["グランス", "グラックス"]);

    expect(result.mergeCandidates).toEqual([]);
  });

  test("長さが開きすぎる組は候補にしない", () => {
    const result = merge(["ギ", "ギルドマスター"]);

    expect(result.mergeCandidates).toEqual([]);
  });

  test("漢字を含む名前は部分一致でも候補にしない", () => {
    // 「田中」と「田中村」のような別人を巻き込まないため
    const result = merge(["田中", "田中村"]);

    expect(result.mergeCandidates).toEqual([]);
  });

  test("すでに別名として統合済みの組は候補にしない", () => {
    const result = mergeExtractedCharacters(
      [],
      [
        { data: { name: "ギルドマスター", aliases: ["ギルマス"] }, chapters: [1] },
      ]
    );

    expect(result.characters).toHaveLength(1);
    expect(result.mergeCandidates).toEqual([]);
  });

  test("実データで別人だった組を候補にしない", () => {
    // 19話の実データに現れた人物名で誤検出が出ないことを確認する
    const result = merge([
      "ジャック",
      "ホンゴー",
      "ケンプ",
      "ヒッコリー",
      "グレイ",
      "グランス",
      "ファーレン",
      "エバン",
      "ウィズ",
      "メアリー",
      "グラックス",
      "ハルト",
      "カッパー",
      "ゴード",
      "シル",
      "カーラーン",
      "アンツ",
      "ジャンヌ",
    ]);

    expect(result.mergeCandidates).toEqual([]);
  });
});

describe("重複レコードの防止", () => {
  function merge(
    entries: Array<{ name: string; aliases?: string[] }>
  ) {
    return mergeExtractedCharacters(
      [],
      entries.map((data) => ({ data, chapters: [1] }))
    );
  }

  test("「先生」付きの呼称を同一人物として統合する", () => {
    // 実データで「マイナ先生」が2レコードに分裂した。
    // 「先輩」は敬称リストにあったが「先生」が無かった。
    const result = merge([{ name: "マイナ" }, { name: "マイナ先生" }]);

    expect(result.characters).toHaveLength(1);
    expect(result.characters[0].aliases).toContain("マイナ先生");
  });

  test("統合先が複数あっても新しい重複を作らず作者へ回す", () => {
    // 「どれに統合すべきか決まらない」ときに黙って新規レコードを作ると、
    // 既存2件に加えて3件目ができ、重複がかえって増える。
    const result = merge([
      { name: "ターナ" },
      { name: "マイナ" },
      // 両方に一致してしまう候補
      { name: "ターナ先生", aliases: ["マイナ"] },
    ]);

    // データは失わないが、曖昧だったことを候補として提示する
    expect(result.mergeCandidates.some((c) => c.reason === "ambiguous")).toBe(
      true
    );
  });

  test("同じ呼称なのに別レコードなら候補として挙げる", () => {
    const a = emptyCharacter("char_001", "ターナ先生");
    const b = emptyCharacter("char_002", "別名");
    b.aliases = ["ターナ先生"];

    const result = mergeExtractedCharacters([a, b], []);

    expect(
      result.mergeCandidates.some(
        (c) => c.reason === "same_name" && c.names.includes("ターナ先生")
      )
    ).toBe(true);
  });

  test("別人を勝手に統合しない", () => {
    const result = merge([{ name: "ターナ" }, { name: "マイナ" }]);

    expect(result.characters).toHaveLength(2);
    expect(result.mergeCandidates).toEqual([]);
  });
});

describe("敬称の吸収", () => {
  function merge(names: string[]) {
    return mergeExtractedCharacters(
      [],
      names.map((name) => ({ data: { name }, chapters: [1] }))
    );
  }

  test.each([
    ["リナ", "リナさん"],
    ["リナ", "リナくん"],
    ["リナ", "リナちゃま"],
    ["リナ", "リナ様"],
    ["リナ", "リナ殿"],
    ["リナ", "リナ氏"],
    ["リナ", "リナ女史"],
    ["リナ", "リナ先輩"],
    ["リナ", "リナ先生"],
    ["リナ", "リナ師"],
    ["リナ", "リナ卿"],
    ["リナ", "リナ翁"],
    ["リナ", "リナ陛下"],
    ["リナ", "リナ殿下"],
    ["リナ", "リナ妃殿下"],
    ["リナ", "リナ閣下"],
    ["リナ", "リナ猊下"],
    ["リナ", "リナ聖下"],
    ["リナ", "リナ姫"],
    ["リナ", "リナ公"],
  ])("%s と %s を同一人物として統合する", (plain, honorific) => {
    const result = merge([plain, honorific]);

    expect(result.characters).toHaveLength(1);
    expect(result.characters[0].aliases).toContain(honorific);
  });

  test("長い敬称を先に照合する", () => {
    // 「妃殿下」は「殿下」でも末尾一致する。短い方を先に試すと
    // 「エレナ妃」が残り、「エレナ」と別人になってしまう。
    const result = merge(["エレナ", "エレナ妃殿下"]);

    expect(result.characters).toHaveLength(1);
  });

  test("敬称だけの名前は切り詰めない", () => {
    // 「殿」1文字を空文字にすると、あらゆる名前と衝突する
    const result = merge(["殿", "陛下"]);

    expect(result.characters).toHaveLength(2);
  });

  test("敬称が付いていない別人を統合しない", () => {
    const result = merge(["リナ", "レナ", "リン"]);

    expect(result.characters).toHaveLength(3);
  });
});
