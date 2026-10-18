import { describe, expect, test } from "vitest";
import { buildReadingPlan } from "../../../src/core/readAloud";
import {
  checkAuthorReading,
  editReading,
  mergeReadingEntries,
  parseReadingDictionary,
  readingChunksOf,
  readingDictionaryFileName,
  readingEntryKey,
  readingSpansFor,
  removeReading,
  validateReadingItems,
  type ReadingEntry,
} from "../../../src/core/readingDictionary";

/**
 * 読みの辞書（設計書6.42.1）。作り物の文だけを使う（作者の原稿は使わない）。
 *
 * 確かめるのは3つ——①声へ渡す写しだけが変わり、位置は元の本文のまま、
 * ②AIの答えを検算で捨てられる、③作者の直しを作り直しで上書きしない。
 */

function ai(word: string, quote: string, reading: string): ReadingEntry {
  return { word, quote, reading, source: "ai" };
}

function plan(
  text: string,
  entries: ReadingEntry[],
  notation: "curly" | "site" = "curly"
) {
  return buildReadingPlan(text, notation, readingSpansFor(text, entries).spans);
}

describe("声へ渡す写しへの当て方", () => {
  test("句の中の語だけを読みへ差し替える。位置は辞書なしと同じ", () => {
    const text = "その音は遠くで鳴った。十分以上待った。";
    const without = buildReadingPlan(text, "curly");
    const withDict = plan(text, [
      ai("音", "その音は", "おと"),
      ai("十分", "十分以上待った", "じっぷん"),
    ]);
    expect(withDict.map((s) => s.speech)).toEqual([
      "そのおとは遠くで鳴った。",
      "じっぷん以上待った。",
    ]);
    expect(withDict.map((s) => [s.start, s.end, s.line])).toEqual(
      without.map((s) => [s.start, s.end, s.line])
    );
  });

  test("同じ語でも、句が違う所には当てない（文脈で読みが変わる）", () => {
    const text = "十分以上待った。\nそれで十分だ。";
    const speeches = plan(text, [ai("十分", "十分以上待った", "じっぷん")]).map(
      (s) => s.speech
    );
    expect(speeches).toEqual(["じっぷん以上待った。", "それで十分だ。"]);
  });

  test("同じ句が2回あれば2回とも当てる", () => {
    const text = "その音は鳴った。\nまたその音は鳴った。";
    const speeches = plan(text, [ai("音", "その音は", "おと")]).map((s) => s.speech);
    expect(speeches).toEqual(["そのおとは鳴った。", "またそのおとは鳴った。"]);
  });

  test("作者のルビが勝つ（curly）", () => {
    const text = "その{音|ね}は鳴った。";
    const speeches = plan(text, [ai("音", "その{音|ね}は", "おと")]).map(
      (s) => s.speech
    );
    expect(speeches).toEqual(["そのねは鳴った。"]);
  });

  test("作者のルビが勝つ（site）", () => {
    const text = "その｜音《ね》は鳴った。";
    const speeches = plan(text, [ai("音", "その｜音《ね》は", "おと")], "site").map(
      (s) => s.speech
    );
    expect(speeches).toEqual(["そのねは鳴った。"]);
  });

  test("ルビの親文字に続く漢字の並びにも当てない（site の親文字は漢字の並び全体）", () => {
    const text = "大十分《だいじゅうぶん》だ。";
    const speeches = plan(text, [ai("十分", "大十分《", "じっぷん")], "site").map(
      (s) => s.speech
    );
    expect(speeches).toEqual(["だいじゅうぶんだ。"]);
  });

  test("本文は1字も変えない（計画の位置から原文を取り戻せる）", () => {
    const text = "　その音は遠くで鳴った。";
    const [sentence] = plan(text, [ai("音", "その音は", "おと")]);
    expect(text.slice(sentence.start, sentence.end)).toBe("その音は遠くで鳴った。");
  });

  test("句が本文に無い項目は当てず、見当たらないものとして返す", () => {
    const result = readingSpansFor("それで十分だ。", [
      ai("十分", "十分以上待った", "じっぷん"),
    ]);
    expect(result.spans).toEqual([]);
    expect(result.missing.map((e) => e.word)).toEqual(["十分"]);
  });

  test("消した項目は当てない。重なったら作者の項目が勝つ", () => {
    const text = "一日中歩いた。";
    const entries: ReadingEntry[] = [
      ai("一日", "一日中歩いた", "ついたち"),
      { word: "一日", quote: "一日中歩", reading: "いちにち", source: "author" },
    ];
    expect(plan(text, entries).map((s) => s.speech)).toEqual(["いちにち中歩いた。"]);
    const removed = removeReading(entries, readingEntryKey(entries[1]));
    expect(plan(text, removed).map((s) => s.speech)).toEqual(["ついたち中歩いた。"]);
  });

  test("シーンメモの行は読まないので、メモの中の句には当たっても声に出ない", () => {
    const text = "// その音はメモ\nその音は鳴った。";
    expect(plan(text, [ai("音", "その音は", "おと")]).map((s) => s.speech)).toEqual([
      "そのおとは鳴った。",
    ]);
  });
});

describe("AIの答えの検算", () => {
  const source = "十分以上待った。\nその音は遠い。\n上手い話だ。";

  test("正しい項目は通る（カタカナの読みはひらがなへ直す）", () => {
    const result = validateReadingItems(source, [
      { word: "十分", quote: "十分以上待った", reading: "じっぷん" },
      { word: "音", quote: "その音は", reading: "オト" },
    ]);
    expect(result.entries).toEqual([
      ai("十分", "十分以上待った", "じっぷん"),
      ai("音", "その音は", "おと"),
    ]);
    expect(result.dropped).toEqual([]);
  });

  test.each<[string, unknown, string]>([
    ["句が本文に無い", { word: "十分", quote: "十分以上かかった", reading: "じっぷん" }, "句が本文に無い"],
    ["句が行をまたぐ", { word: "十分", quote: "待った。\nその", reading: "じっぷん" }, "句が本文に無い"],
    ["語が句に無い", { word: "一日", quote: "十分以上待った", reading: "いちにち" }, "語が句に無い"],
    ["句が語だけ", { word: "十分", quote: "十分", reading: "じっぷん" }, "句が語だけ"],
    ["語に漢字が無い", { word: "その", quote: "その音は", reading: "その" }, "語に漢字が無い"],
    ["読みに漢字", { word: "十分", quote: "十分以上待った", reading: "十ぷん" }, "読みがひらがなでない"],
    ["読みが指示の言葉（ひらがな）", { word: "十分", quote: "十分以上待った", reading: "ひらがな" }, "読みが指示の言葉"],
    ["読みが指示の言葉（読み）", { word: "十分", quote: "十分以上待った", reading: "よみ" }, "読みが指示の言葉"],
    ["読みが短すぎる", { word: "十分", quote: "十分以上待った", reading: "じ" }, "読みの長さが合わない"],
    ["送り仮名が合わない", { word: "上手い", quote: "上手い話", reading: "じょうず" }, "送り仮名が合わない"],
    ["形が違う", { word: "十分", quote: "十分以上待った" }, "形が違う"],
    ["句が長すぎる", { word: "十分", quote: "十分".padEnd(40, "あ"), reading: "じっぷん" }, "句が長すぎる"],
  ])("%s は捨てる", (_label, item, reason) => {
    const result = validateReadingItems(source, [item]);
    expect(result.entries).toEqual([]);
    expect(result.dropped.map((d) => d.reason)).toEqual([reason]);
  });

  test("句の前の字まで読みに含めた答えは捨てる（gemma4:e4b の実際の答え、2026-10-19）", () => {
    // 声へ渡すと「最初のさいしょのいちぎょうを書き直した」になり、読みが壊れる
    const result = validateReadingItems("最初の一行を書き直した。", [
      { word: "一行", quote: "最初の一行を書き直した。", reading: "さいしょのいちぎょう" },
    ]);
    expect(result.entries).toEqual([]);
    expect(result.dropped.map((d) => d.reason)).toEqual(["読みの長さが合わない"]);
  });

  test("漢字1字に4音までの読みは通す（承る＝うけたまわる）", () => {
    const result = validateReadingItems("謹んで承ります。", [
      { word: "承る", quote: "謹んで承ります", reading: "うけたまわる" },
    ]);
    // 句に「承る」は無いので語が句に無い——ここで見たいのは長さの線なので、句を合わせる
    expect(result.dropped.map((d) => d.reason)).toEqual(["語が句に無い"]);
    const ok = validateReadingItems("謹んで承る。", [
      { word: "承る", quote: "謹んで承る", reading: "うけたまわる" },
    ]);
    expect(ok.entries).toHaveLength(1);
  });

  test("同じ語・同じ句は1つに畳む", () => {
    const item = { word: "音", quote: "その音は", reading: "おと" };
    const result = validateReadingItems(source, [item, item]);
    expect(result.entries).toHaveLength(1);
    expect(result.dropped.map((d) => d.reason)).toEqual(["重複"]);
  });
});

describe("作り直しと作者の直し", () => {
  test("作者が直した読みは、作り直しで上書きしない", () => {
    const first = [ai("十分", "十分以上待った", "じゅうぶん")];
    const edited = editReading(first, readingEntryKey(first[0]), "じっぷん");
    expect(edited[0]).toEqual({
      word: "十分",
      quote: "十分以上待った",
      reading: "じっぷん",
      source: "author",
    });
    const merged = mergeReadingEntries(edited, [
      ai("十分", "十分以上待った", "じゅうぶん"),
      ai("音", "その音は", "おと"),
    ]);
    expect(merged).toEqual([edited[0], ai("音", "その音は", "おと")]);
  });

  test("作者が消した項目は、作り直しで戻さない", () => {
    const first = [ai("音", "その音は", "おん")];
    const removed = removeReading(first, readingEntryKey(first[0]));
    const merged = mergeReadingEntries(removed, [ai("音", "その音は", "おん")]);
    expect(merged).toEqual([
      { word: "音", quote: "その音は", reading: "おん", source: "author", removed: true },
    ]);
  });

  test("AIの古い項目は新しい答えで入れ替わる", () => {
    const merged = mergeReadingEntries(
      [ai("音", "その音は", "おと")],
      [ai("十分", "十分以上待った", "じっぷん")]
    );
    expect(merged).toEqual([ai("十分", "十分以上待った", "じっぷん")]);
  });

  test("作者の読みの入力を確かめる", () => {
    expect(checkAuthorReading("じっぷん")).toBeUndefined();
    expect(checkAuthorReading("ジップン")).toBeUndefined();
    expect(checkAuthorReading("十ぷん")).toBeDefined();
    expect(checkAuthorReading("")).toBeDefined();
  });
});

describe("送る区切りとファイル", () => {
  test("行の切れ目でだけ切り、シーンメモは送らない", () => {
    const text = ["あいうえお", "// メモ", "かきくけこ", "さしすせそ"].join("\n");
    const chunks = readingChunksOf(text, 12);
    expect(chunks.map((c) => c.text)).toEqual(["あいうえお\nかきくけこ", "さしすせそ"]);
  });

  test("壊れたファイルは直さずに投げる", () => {
    expect(() => parseReadingDictionary("{")).toThrow();
    expect(() =>
      parseReadingDictionary(JSON.stringify({ version: 1, entries: [{ word: 1 }] }))
    ).toThrow();
  });

  test("読み書きで項目が変わらない", () => {
    const file = {
      version: 1 as const,
      episode: "本文/第1話.txt",
      entries: [
        ai("音", "その音は", "おと"),
        { word: "十分", quote: "十分以上", reading: "じっぷん", source: "author" as const, removed: true },
      ],
    };
    expect(parseReadingDictionary(JSON.stringify(file))).toEqual(file);
  });

  test("入れ子の話でも1段のファイル名にする", () => {
    expect(readingDictionaryFileName("本文/第1章/第1話.txt")).toBe(
      "本文__第1章__第1話.txt.json"
    );
  });
});
