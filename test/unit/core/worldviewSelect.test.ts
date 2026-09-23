import { describe, expect, test } from "vitest";
import { describeWorldItem } from "../../src/core/settingsSummary";
import {
  WORLDVIEW_MAX_CHARS,
  selectWorldview,
} from "../../src/core/worldviewSelect";
import { emptyWorldItem, type WorldItem } from "../../src/models/world";

/**
 * 矛盾検知へ渡す世界観の絞り（設計書6.27.6の穴2）。
 *
 * いちばん大事なのは**上限内で従来と1文字も変わらない**ことである。
 * ここが崩れると、いまの作品でも送る内容が変わってキャッシュが飛び、
 * 「大きな作品だけで絞りが効く」という約束も崩れる。
 */

function item(options: {
  id: string;
  name: string;
  description: string;
  aliases?: string[];
  chapters?: number[];
}): WorldItem {
  return {
    ...emptyWorldItem(options.id, options.name),
    aliases: options.aliases ?? [],
    description: options.description,
    appearedChapters: options.chapters ?? [],
  };
}

/** 名前だけでは選ばれない、かさばる項目を作る */
function filler(id: string, name: string, size: number): WorldItem {
  return item({ id, name, description: "詳細".repeat(size) });
}

describe("世界観の絞り", () => {
  test("上限内なら、全項目が元の並び順のまま入る", () => {
    const items = [
      item({ id: "world_001", name: "詠唱の制約", description: "唱え終えるまで動けない" }),
      item({ id: "world_002", name: "銀貨の価値", description: "銀貨三枚が一日の宿代" }),
      item({ id: "world_003", name: "王都の門限", description: "日没で閉じる" }),
    ];

    const selected = selectWorldview({
      items,
      // 本文に1件も名前が出ていなくても、上限内なら全部入る
      chunkText: "誰も彼もが黙って歩いていた。",
      chapter: 3,
    });

    // **従来の組み立て（map して join）と完全一致**であること
    expect(selected).toBe(items.map(describeWorldItem).join("\n\n"));
  });

  test("上限内なら、話数が分からなくても全項目が入る", () => {
    const items = [
      item({ id: "world_001", name: "詠唱の制約", description: "唱え終えるまで動けない" }),
      item({ id: "world_002", name: "銀貨の価値", description: "銀貨三枚が一日の宿代" }),
    ];

    expect(
      selectWorldview({ items, chunkText: "本文", chapter: null })
    ).toBe(items.map(describeWorldItem).join("\n\n"));
  });

  test("上限を超えるとき、本文に名前が出る項目は長い項目より先に残る", () => {
    const named = item({
      id: "world_009",
      name: "詠唱の制約",
      description: "唱え終えるまで足を止めてはならない",
    });
    // 名前も本文に出ず、その話の登場記録も無い大物を前に置く。
    // 元の並び順で詰めていたら、これだけで枠が埋まる
    const items = [filler("world_001", "銀貨の価値", 200), named];

    const selected = selectWorldview({
      items,
      chunkText: "彼は詠唱の制約を思い出して足を止めなかった。",
      chapter: 3,
      maxChars: 300,
    });

    expect(selected).toContain("詠唱の制約");
    expect(selected).not.toContain("銀貨の価値");
  });

  test("上限を超えるとき、別の言い方が本文に出れば名前一致として残る", () => {
    const aliased = item({
      id: "world_009",
      name: "詠唱の制約",
      description: "唱え終えるまで足を止めてはならない",
      aliases: ["歩き詠唱の禁"],
    });
    const items = [filler("world_001", "銀貨の価値", 200), aliased];

    const selected = selectWorldview({
      items,
      chunkText: "歩き詠唱の禁を破った者はいない。",
      chapter: 3,
      maxChars: 300,
    });

    expect(selected).toContain("詠唱の制約");
  });

  test("上限を超えるとき、名前が出ていなくてもその話に登場した項目は残る", () => {
    // 本文が「詠唱の制約」を言い換えている場合の保険。
    // 見出しは本文に出てこないのが世界観の常なので、ここが効く
    const byChapter = item({
      id: "world_009",
      name: "詠唱の制約",
      description: "唱え終えるまで足を止めてはならない",
      chapters: [3],
    });
    const items = [filler("world_001", "銀貨の価値", 200), byChapter];

    const selected = selectWorldview({
      items,
      chunkText: "唱えきるまでは、どんなことがあっても動いてはいけない。",
      chapter: 3,
      maxChars: 300,
    });

    expect(selected).toContain("詠唱の制約");
    expect(selected).not.toContain("銀貨の価値");
  });

  test("上限を超えるとき、残り枠は本文と語句の近い項目から埋まる", () => {
    // どれも名前は本文に出ず、登場話の記録も無い。順位は語句の近さだけで決まる
    const items = [
      item({
        id: "world_001",
        name: "遠いもの",
        description: "船乗りは潮の流れを読んで舵を切る",
      }),
      item({
        id: "world_002",
        name: "近いもの",
        description: "銀貨三枚が一日の宿代になる",
      }),
    ];

    const selected = selectWorldview({
      items,
      chunkText: "宿の主人は銀貨三枚を受け取った。",
      chapter: null,
      // 1件だけが入る大きさ
      maxChars: 60,
    });

    expect(selected).toContain("近いもの");
    expect(selected).not.toContain("遠いもの");
  });

  test("上限を超えるとき、出力は上限を超えない", () => {
    const items = [
      filler("world_001", "第一", 100),
      filler("world_002", "第二", 100),
      filler("world_003", "第三", 100),
    ];

    const selected = selectWorldview({
      items,
      chunkText: "詳細を語る声がした。",
      chapter: null,
      maxChars: 500,
    });

    expect(selected.length).toBeLessThanOrEqual(500);
    // 全部は入らない＝ちゃんと切っている
    expect(selected.length).toBeLessThan(
      items.map(describeWorldItem).join("\n\n").length
    );
  });

  test("語句が1つも重ならなくても、世界観は空にならない", () => {
    // 本文が短いと、共通する2文字組みが1つも無いことがある。
    // BM25は0点の文書を返さないので、そこで落とすと材料が丸ごと消える。
    // 材料が空のまま問うと、AIは本文だけを見て矛盾を作り出す
    const items = [
      filler("world_001", "第一", 100),
      filler("world_002", "第二", 100),
    ];

    const selected = selectWorldview({
      items,
      chunkText: "「ああ」",
      chapter: null,
      maxChars: 500,
    });

    expect(selected).not.toBe("");
  });

  test("1件目からはみ出すときだけ、その1件は上限を超えても渡す", () => {
    // 材料が空になると、矛盾検知は「照らし合わせる相手が無い」と見なして
    // そのチャンクを飛ばす。1件も渡さないより、はみ出してでも渡す
    const items = [filler("world_001", "大物", 100)];

    const selected = selectWorldview({
      items,
      chunkText: "本文",
      chapter: null,
      maxChars: 10,
    });

    expect(selected).toBe(describeWorldItem(items[0]));
    expect(selected.length).toBeGreaterThan(10);
  });

  test("同じ入力なら、2回呼んでも同じ文字列になる", () => {
    // キャッシュの鍵は「設定の指紋＋チャンクのハッシュ」なので、
    // 選抜が揺れると同じ鍵に違う材料の答えが入る
    const items = [
      item({ id: "world_001", name: "詠唱の制約", description: "唱え終えるまで動けない" }),
      filler("world_002", "銀貨の価値", 200),
      item({ id: "world_003", name: "王都の門限", description: "日没で門が閉じる", chapters: [3] }),
      filler("world_004", "潮の流れ", 200),
    ];
    const call = (): string =>
      selectWorldview({
        items,
        chunkText: "門が閉じる前に、彼は銀貨を数えた。",
        chapter: 3,
        maxChars: 400,
      });

    expect(call()).toBe(call());
  });

  test("項目が無ければ空文字を返す", () => {
    expect(selectWorldview({ items: [], chunkText: "本文", chapter: 1 })).toBe("");
  });

  test("既定の上限は、推定の最大（20,000字超）より上に置く", () => {
    // 上限を推定より下げると、いまの作品でも挙動が変わってしまう。
    // 下げるのは実測（usage.md）を見てからで、それは本体が決める
    expect(WORLDVIEW_MAX_CHARS).toBeGreaterThan(20000);
  });
});
