import { describe, expect, test } from "vitest";
import type { Chunk } from "../../src/core/chunker";
import { validateExtractedWorldItems } from "../../src/core/settingsExtractionValidation";
import { mergeExtractedWorldItems } from "../../src/core/settingsMerge";
import { buildWorldMarkdown } from "../../src/core/settingsMarkdown";
import { buildWorldListItems } from "../../src/core/settingsList";
import { applyWorldItemEdits } from "../../src/core/settingsEdit";
import { describeWorldItem } from "../../src/core/settingsSummary";
import { searchTermsFor } from "../../src/features/settingsPanel";
import {
  GENERATED_MARKER,
  isGeneratedDoc,
} from "../../src/features/generateSettingsDocs";
import { emptyWorldItem, type WorldItem } from "../../src/models/world";

/**
 * 世界観（P-03）の抽出から資料までを通しで固定する。
 *
 * いちばん壊れやすいのは検証で、**見出しは本文に出てこない**という点が
 * 他の種別と違う。名前の実在を求めると全件落ちるため、そこを重点的に見る。
 */

const ruleLine = "詠唱を終えるまで足を止めてはならないと教わった";
const chunk: Chunk = {
  filePath: "003.txt",
  index: 0,
  text: `${ruleLine}。\n王都では銀貨三枚が一日の宿代になる。`,
  startLine: 0,
  hash: "fixture",
  chapterStart: 3,
  chapterEnd: 3,
};

describe("世界観の検証", () => {
  test("見出しが本文に無くても、引用が逐語で一致すれば受理する", () => {
    // 「詠唱の制約」はこちらが付けた見出しで、本文には出てこない。
    // 名前の実在を条件にすると、正しく抽出できた項目まですべて落ちる
    const result = validateExtractedWorldItems(
      [
        {
          name: "詠唱の制約",
          category: "rule",
          description: "詠唱中は移動できない。",
          evidence: ruleLine,
        },
      ],
      chunk
    );

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].category).toBe("rule");
    expect(result.accepted[0].chapters).toEqual([3]);
  });

  test("引用が本文に無ければ捏造として除外する", () => {
    const result = validateExtractedWorldItems(
      [
        {
          name: "飛行の禁忌",
          category: "rule",
          description: "空を飛ぶことは禁じられている。",
          evidence: "空を飛ぶ者は罰せられると法に記されている",
        },
      ],
      chunk
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([
      { name: "飛行の禁忌", reason: "ungrounded" },
    ]);
  });

  test("中身の無い見出しは資料に並べても伝わらないので除外する", () => {
    const result = validateExtractedWorldItems(
      [
        { name: "通貨", category: "society", description: null, evidence: ruleLine },
        {
          name: "気候",
          category: "geography",
          description: "（本文から読み取れる記述なし）",
          evidence: ruleLine,
        },
      ],
      chunk
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "not_worldview",
      "not_worldview",
    ]);
  });

  test("話数を名指しした記述は出来事なので除外する", () => {
    const result = validateExtractedWorldItems(
      [
        {
          name: "城の炎上",
          category: "society",
          description: "第3話で城が燃えた。",
          evidence: ruleLine,
        },
      ],
      chunk
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([
      { name: "城の炎上", reason: "not_worldview" },
    ]);
  });

  test("知らない分類でも項目は捨てず、受け皿の term に寄せる", () => {
    // 分類は資料の見出しを決めるだけで、中身の正しさとは関係がない。
    // 捨てると本文から読み取れた内容まで失われる
    const result = validateExtractedWorldItems(
      [
        {
          name: "宿代の相場",
          category: "経済",
          description: "銀貨三枚で一日泊まれる。",
          evidence: "王都では銀貨三枚が一日の宿代になる",
        },
      ],
      chunk
    );

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].category).toBe("term");
  });

  test("本文の丸写しのような長い見出しを弾く", () => {
    const result = validateExtractedWorldItems(
      [
        {
          name: "詠唱を終えるまで足を止めてはならないという決まりごと",
          category: "rule",
          description: "詠唱中は移動できない。",
          evidence: ruleLine,
        },
      ],
      chunk
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]?.reason).toBe("invalid_name");
  });
});

describe("世界観のマージ", () => {
  const incoming = (
    name: string,
    description: string,
    category: "rule" | "term" | "society" = "rule",
    chapters = [3]
  ) => ({
    data: { name, description, evidence: ruleLine },
    category,
    chapters,
  });

  test("同じ見出しは1件にまとまり、話数が足される", () => {
    const first = mergeExtractedWorldItems(
      [],
      [incoming("詠唱の制約", "詠唱中は移動できない。")]
    );
    const second = mergeExtractedWorldItems(first.items, [
      incoming("詠唱の制約", "詠唱中は移動できない。", "rule", [7]),
    ]);

    expect(second.items).toHaveLength(1);
    expect(second.items[0].appearedChapters).toEqual([3, 7]);
    expect(second.added).toEqual([]);
  });

  test("食い違う説明は上書きせず conflicts に残す", () => {
    const first = mergeExtractedWorldItems(
      [],
      [incoming("通貨の単位", "銀貨が使われる。")]
    );
    const second = mergeExtractedWorldItems(first.items, [
      incoming("通貨の単位", "金貨が使われる。"),
    ]);

    expect(second.items[0].description).toBe("銀貨が使われる。");
    expect(second.items[0].conflicts[0].values).toEqual([
      "銀貨が使われる。",
      "金貨が使われる。",
    ]);
  });

  test("作者が確定させた項目は登場話数以外を変えない", () => {
    const authored: WorldItem = {
      ...emptyWorldItem("world_001", "詠唱の制約", "rule"),
      description: "作者が書いた説明。",
      authorNotes: "ここは後で書き直す",
      autoGenerated: false,
    };

    const merged = mergeExtractedWorldItems(
      [authored],
      [incoming("詠唱の制約", "AIが書いた説明。", "rule", [9])]
    );

    expect(merged.items[0].description).toBe("作者が書いた説明。");
    expect(merged.items[0].authorNotes).toBe("ここは後で書き直す");
    expect(merged.items[0].appearedChapters).toEqual([9]);
  });

  test("受け皿の term に入った項目は、具体的な分類が来たら寄せる", () => {
    const first = mergeExtractedWorldItems(
      [],
      [incoming("宿代の相場", "銀貨三枚。", "term")]
    );
    const second = mergeExtractedWorldItems(first.items, [
      incoming("宿代の相場", "銀貨三枚。", "society"),
    ]);

    expect(second.items[0].category).toBe("society");
  });

  test("決まった分類は、あとから別の分類が来ても変えない", () => {
    // 1つの項目が複数の分類に当てはまるのは普通のことで、
    // 作者に判断を求めても得るものがない
    const first = mergeExtractedWorldItems(
      [],
      [incoming("詠唱の制約", "詠唱中は移動できない。", "rule")]
    );
    const second = mergeExtractedWorldItems(first.items, [
      incoming("詠唱の制約", "詠唱中は移動できない。", "society"),
    ]);

    expect(second.items[0].category).toBe("rule");
    expect(second.items[0].conflicts).toEqual([]);
  });
});

describe("世界観の資料と一覧", () => {
  const items: WorldItem[] = [
    {
      ...emptyWorldItem("world_001", "詠唱の制約", "rule"),
      description: "詠唱中は移動できない。",
      appearedChapters: [3, 4],
      exportNote: "続編では緩和される予定",
    },
    {
      ...emptyWorldItem("world_002", "通貨の単位", "society"),
      description: "銀貨と銅貨が使われる。",
    },
  ];

  test("分類ごとに節を分け、該当の無い分類は出さない", () => {
    const markdown = buildWorldMarkdown(items, { workTitle: "作品" });

    expect(markdown).toContain("# 作品 世界観");
    expect(markdown).toContain("## 世界の法則");
    expect(markdown).toContain("### 詠唱の制約");
    expect(markdown).toContain("## 社会構造");
    // 該当が1件も無い分類の見出しは出さない
    expect(markdown).not.toContain("## 地理");
    expect(markdown).toContain("- **補足**: 続編では緩和される予定");
    expect(markdown).toContain("- **登場話**: 第3、4話");
  });

  test("1件も無ければ、その旨だけを書く", () => {
    const markdown = buildWorldMarkdown([], { workTitle: "作品" });

    expect(markdown).toContain("まだ世界観が登録されていません。");
  });

  test("一覧には分類を添える", () => {
    const list = buildWorldListItems(items);

    expect(list[0]).toMatchObject({
      id: "world_001",
      name: "詠唱の制約",
      sub: "世界の法則",
      isMob: false,
    });
  });

  test("AIへ渡す説明には空の項目を入れない", () => {
    const described = describeWorldItem(items[1]);

    expect(described).toContain("見出し: 通貨の単位");
    expect(described).toContain("分類: 社会構造");
    // 空の項目を「なし」と書くと、AIがそれを事実として扱いかねない
    expect(described).not.toContain("登場話");
  });
});

describe("世界観の書き換え", () => {
  const item = {
    ...emptyWorldItem("world_001", "詠唱の制約", "rule"),
    description: "詠唱中は移動できない。",
  };

  test("作者が保存すると、以後の抽出で上書きされなくなる", () => {
    const edited = applyWorldItemEdits(item, {
      description: "詠唱中は歩けない。",
    });

    expect(edited.description).toBe("詠唱中は歩けない。");
    expect(edited.autoGenerated).toBe(false);
  });

  test("AIの提案を採用しただけなら作者確定にしない", () => {
    const edited = applyWorldItemEdits(
      item,
      { description: "AIが書いた説明。" },
      { authorConfirmed: false }
    );

    expect(edited.autoGenerated).toBe(true);
  });

  test("知らない分類は書き込まず、今の分類を残す", () => {
    // 検証で落ちるJSONを保存すると、作者が手で直す羽目になる
    const edited = applyWorldItemEdits(item, { category: "経済" });

    expect(edited.category).toBe("rule");
  });

  test("選択肢から選んだ分類は反映する", () => {
    const edited = applyWorldItemEdits(item, { category: "society" });

    expect(edited.category).toBe("society");
  });
});

describe("作者が書いた資料を上書きしない", () => {
  test("生成物の印が無いファイルは作者のものとみなす", () => {
    // 設計書は world.md を「AI自動生成＋作者の加筆」としていた。
    // その案で書き始めた作者のファイルが残っている可能性がある
    expect(isGeneratedDoc("# わたしの世界設定\n\n王国は3つある。")).toBe(false);
  });

  test("自分で書いたファイルは作り直してよい", () => {
    expect(isGeneratedDoc(`<!-- ${GENERATED_MARKER} -->\n\n# 作品 世界観`)).toBe(
      true
    );
  });
});

describe("本文から場面を集めるときの検索語", () => {
  test("世界観は見出しで引けないので、引用を検索語に足す", () => {
    const terms = searchTermsFor("world", {
      name: "詠唱の制約",
      aliases: [],
      evidence: `「${ruleLine}」`,
    });

    expect(terms).toContain("詠唱の制約");
    expect(terms).toContain(ruleLine);
  });

  test("他の種別は名前だけで引く", () => {
    const terms = searchTermsFor("location", {
      name: "図書塔",
      aliases: [],
      evidence: "図書塔の階段を上る",
    });

    expect(terms).toEqual(["図書塔"]);
  });
});
