import { describe, expect, test } from "vitest";
import {
  IME_FREQUENT_MIN_COUNT,
  countFrequentWords,
  frequentSkipSurfaces,
  isEpisodeFilePath,
  nextFrequentExcluded,
} from "../../../src/core/imeFrequent";

const none = new Set<string>();
const times = (text: string, n: number): string => Array.from({ length: n }, () => text).join("。");

describe("よく使う語を数える", () => {
  test("定数は3回", () => {
    expect(IME_FREQUENT_MIN_COUNT).toBe(3);
  });

  test("内部記法のルビ語を数える（読みはルビ）", () => {
    const body = times("{魔法陣|まほうじん}が光る", 3);
    expect(countFrequentWords([body], none)).toEqual([
      { surface: "魔法陣", reading: "まほうじん", count: 3 },
    ]);
  });

  test("サイト記法3種を数える", () => {
    const bodies = ["｜魔法陣《まほうじん》", "魔法陣《まほうじん》", "#魔法陣__まほうじん__#"];
    expect(countFrequentWords(bodies, none)).toEqual([
      { surface: "魔法陣", reading: "まほうじん", count: 3 },
    ]);
  });

  test("回数は話をまたいで数える・3回未満は出さない", () => {
    const rare = times("{魔法陣|まほうじん}", 2);
    expect(countFrequentWords([rare], none)).toEqual([]);
    expect(countFrequentWords([rare, "{魔法陣|まほうじん}"], none)).toHaveLength(1);
  });

  test("カタカナは3字以上だけ・読みはひらがな", () => {
    const body = times("ドラゴンとゲームとネコ", 3);
    expect(countFrequentWords([body], none)).toEqual([
      { surface: "ゲーム", reading: "げーむ", count: 3 },
      { surface: "ドラゴン", reading: "どらごん", count: 3 },
    ]);
  });

  test("長音だけ・長音で始まるカタカナは出さない", () => {
    const body = times("ーーー ーアイス", 4);
    expect(countFrequentWords([body], none)).toEqual([]);
  });

  test("設定資料の表記と外した語は出さない", () => {
    const body = times("ドラゴンと{魔法陣|まほうじん}とゲーム", 3);
    const got = countFrequentWords([body], new Set(["ドラゴン", "魔法陣"]));
    expect(got.map((one) => one.surface)).toEqual(["ゲーム"]);
  });

  test("ひらがなだけ・漢字だけでルビ無し・1字は出さない", () => {
    const body = times("{ひらがな|ひらがな}と魔法陣と{氷|こおり}", 5);
    expect(countFrequentWords([body], none)).toEqual([]);
  });

  test("読みが同じで表記が2つなら両方出る。表記が違えば別の行", () => {
    const body = times("{異世界|いせかい}と{異世界|いせかい}", 2) + times("{位世界|いせかい}", 3);
    const got = countFrequentWords([body], none);
    expect(got.map((one) => one.surface).sort()).toEqual(["位世界", "異世界"]);
  });

  test("ルビ付きのカタカナは二重に数えない", () => {
    const body = times("{ドラゴン|どらごん}", 3);
    expect(countFrequentWords([body], none)).toEqual([
      { surface: "ドラゴン", reading: "どらごん", count: 3 },
    ]);
  });

  test("並びは回数の多い順、同じなら表記の順で、毎回同じ", () => {
    const body = [times("ゲーム", 3), times("アイス", 3), times("ドラゴン", 5)].join("。");
    const a = countFrequentWords([body], none);
    const b = countFrequentWords([body], none);
    expect(a.map((one) => one.surface)).toEqual(["ドラゴン", "アイス", "ゲーム"]);
    expect(b).toEqual(a);
  });

  test("本文の文は出力に含まれない", () => {
    const sentence = "彼女は静かに{魔法陣|まほうじん}の前に立ち、ドラゴンを見上げた";
    const got = countFrequentWords([times(sentence, 3)], none);
    const json = JSON.stringify(got);
    expect(json).not.toContain("静かに");
    expect(json).not.toContain("見上げた");
    expect(got.length).toBe(2);
  });
});

describe("話のファイルの判定", () => {
  const work = "C:/w/作品";
  const settings = "C:/w/作品/設定";
  const yes = (file: string): boolean => isEpisodeFilePath(work, settings, file);

  test("話の .txt/.md は真", () => {
    expect(yes("C:/w/作品/本文/第001話.txt")).toBe(true);
    expect(yes("C:/w/作品/本文/第一章/第002話.md")).toBe(true);
    expect(yes("C:/w/作品/第003話.txt")).toBe(true);
  });

  test(".aiwriter・回復先・ゴミ箱・書き出しの写し・設定の下は偽", () => {
    expect(yes("C:/w/作品/.aiwriter/cache/第001話.txt")).toBe(false);
    expect(yes("C:/w/作品/本文/.novelai-recovery/第001話.txt")).toBe(false);
    expect(yes("C:/w/作品/.trash/第001話.txt")).toBe(false);
    expect(yes("C:/w/作品/exports/ime/第001話.txt")).toBe(false);
    expect(yes("C:/w/作品/設定/characters/人物.md")).toBe(false);
  });

  test("設定資料の JSON・README・作品の外は偽", () => {
    expect(yes("C:/w/作品/設定/characters/a.json")).toBe(false);
    expect(yes("C:/w/作品/README.md")).toBe(false);
    expect(yes("C:/w/別の作品/第001話.txt")).toBe(false);
  });
});

describe("外した語の覚えの合わせ方", () => {
  test("前の覚え＋今回外した語−今回チェックした語", () => {
    // 前に外した A・B。今回の一覧は B・C・D、チェックは B（戻した）・D。C を外した
    expect(nextFrequentExcluded(["A", "B"], ["B", "C", "D"], ["B", "D"]).sort()).toEqual(["A", "C"]);
  });

  test("一覧に出ない語の覚えは消さない", () => {
    expect(nextFrequentExcluded(["A"], ["X"], ["X"])).toEqual(["A"]);
  });
});

describe("よく使う語から除く表記", () => {
  test("設定資料の語・外した語・よく使う語として外した語が入る", () => {
    const skip = frequentSkipSurfaces(["魔法陣"], ["外し1"], ["外し2"]);
    expect([...skip].sort()).toEqual(["外し1", "外し2", "魔法陣"].sort());
    const words = countFrequentWords(
      [times("{外し2|はずし}と{残る|のこる}", 3)],
      skip
    );
    expect(words.map((word) => word.surface)).toEqual(["残る"]);
  });
});
