import { describe, expect, test } from "vitest";
import { buildReadingPlan } from "../../../src/core/readAloud";
import {
  captureImeReading,
  decideImeReading,
  imeSuggestionFor,
  mergeReadingSpans,
  nameReadingSpans,
  nameReadingsFrom,
  parseImeReadingFile,
  primaryImeReadings,
  readingFromComposition,
  recordImeReadingEntry,
  type CompositionEvent,
  type ImeReadingFile,
} from "../../../src/core/imeReading";

/**
 * IMEで打った読みを拾う（設計書6.42.2）。作り物の名前だけを使う。
 *
 * 確かめるのは4つ——①変換の流れから読みを取り出し、名前と完全に一致したときだけ
 * 採る、②控えの読み書き、③設定資料へ書く／提案にする の分かれ目、
 * ④読み上げの優先（ルビ＞辞書＞設定資料＞IME）。
 */

const NAMES = ["灯", "灯里", "霧ヶ峰", "白樺の森", "東雲", "リオ"];

/** 記録した変換の流れ（日本語IMEで実際に起きる並び） */
function flow(...steps: Array<[CompositionEvent["type"], string]>): CompositionEvent[] {
  return steps.map(([type, data]) => ({ type, data }));
}

describe("変換の流れから読みを取り出す", () => {
  test("かなだけだった最後の状態が読みになる", () => {
    const events = flow(
      ["update", "あ"],
      ["update", "あか"],
      ["update", "あかり"],
      ["update", "灯"],
      ["end", "灯"]
    );
    expect(readingFromComposition(events)).toEqual({ kana: "あかり", committed: "灯" });
  });

  test("候補を選び直しても、読みは最後にかなだけだった状態のまま", () => {
    const events = flow(
      ["update", "あかり"],
      ["update", "明かり"],
      ["update", "灯"],
      ["end", "灯"]
    );
    expect(readingFromComposition(events)?.kana).toBe("あかり");
  });

  test("確定の知らせに字が無ければ、最後に入った字を確定とみる", () => {
    const events = flow(["update", "あかり"], ["update", "灯"], ["input", "灯"], ["end", ""]);
    // end の data が空の文字列なら取り消し（Esc）なので拾わない
    expect(readingFromComposition(events)).toBeUndefined();
    const noData: CompositionEvent[] = [
      { type: "update", data: "あかり" },
      { type: "update", data: "灯" },
      { type: "input", data: "灯" },
      { type: "end" },
    ];
    expect(readingFromComposition(noData)).toEqual({ kana: "あかり", committed: "灯" });
  });

  test("一度もかなだけにならなかった流れからは取らない", () => {
    expect(readingFromComposition(flow(["update", "灯"], ["end", "灯"]))).toBeUndefined();
  });
});

describe("名前と完全に一致したときだけ採る", () => {
  test("そのまま一致する", () => {
    expect(captureImeReading("あかり", "灯", NAMES)).toEqual({ surface: "灯", reading: "あかり" });
  });

  test("助詞つき：前後の共通のかなを外す（「灯は」と「あかりは」）", () => {
    expect(captureImeReading("あかりは", "灯は", NAMES)).toEqual({
      surface: "灯",
      reading: "あかり",
    });
    expect(captureImeReading("おおあかりが", "おお灯が", NAMES)).toEqual({
      surface: "灯",
      reading: "あかり",
    });
  });

  test("部分変換：うしろが変換されずにかなのまま確定した", () => {
    expect(captureImeReading("あかりはきた", "灯はきた", NAMES)).toEqual({
      surface: "灯",
      reading: "あかり",
    });
  });

  test("うしろにも漢字がある確定は、どこまでが名前の読みか決まらないので捨てる", () => {
    expect(captureImeReading("あかりはきた", "灯は来た", NAMES)).toBeUndefined();
  });

  test("長い名前を先に当てる（「灯里」の中の「灯」で採らない）", () => {
    expect(captureImeReading("あかり", "灯里", NAMES)).toEqual({
      surface: "灯里",
      reading: "あかり",
    });
  });

  test("名前の中のかな（ヶ・の）は読みの側と合わせて見る", () => {
    expect(captureImeReading("きりがみね", "霧ヶ峰", NAMES)).toEqual({
      surface: "霧ヶ峰",
      reading: "きりがみね",
    });
    expect(captureImeReading("しらかばのもり", "白樺の森", NAMES)).toEqual({
      surface: "白樺の森",
      reading: "しらかばのもり",
    });
    // 名前の「の」が読みに無い＝別の語
    expect(captureImeReading("しらかばもり", "白樺の森", NAMES)).toBeUndefined();
  });

  test("カタカナで打った読みはひらがなへ直す", () => {
    expect(captureImeReading("シノノメ", "東雲", NAMES)).toEqual({
      surface: "東雲",
      reading: "しののめ",
    });
  });

  test("送り仮名の付いたふつうの語（「灯り」）を、名前の読みと取り違えない", () => {
    expect(captureImeReading("あかり", "灯り", NAMES)).toBeUndefined();
    expect(captureImeReading("あかりさんは", "灯さんは", NAMES)).toEqual({
      surface: "灯",
      reading: "あかり",
    });
  });

  test("部分一致は捨てる（名前でない語の一部に名前が入っているだけ）", () => {
    expect(captureImeReading("とうだい", "灯台", NAMES)).toBeUndefined();
  });

  test("カタカナ名・かなだけの確定は採らない", () => {
    expect(captureImeReading("りお", "リオ", NAMES)).toBeUndefined();
    expect(captureImeReading("あかり", "あかり", NAMES)).toBeUndefined();
  });

  test("予測変換で途中の読みしか無いもの（読みが名前の漢字の数より短い）は捨てる", () => {
    // 「あか」まで打って候補から「灯里」を選んだ
    expect(captureImeReading("あ", "灯里", NAMES)).toBeUndefined();
    expect(captureImeReading("しの", "東雲", NAMES)).toEqual({ surface: "東雲", reading: "しの" });
  });

  test("名前に無い語は採らない", () => {
    expect(captureImeReading("かわ", "川", NAMES)).toBeUndefined();
  });
});

describe("控えの読み書き", () => {
  const empty: ImeReadingFile = { version: 1, entries: [] };

  test("同じ名前・同じ読みは回数を足す", () => {
    let file = recordImeReadingEntry(empty, { surface: "灯", reading: "あかり" }, "2026-10-24T01:00:00Z");
    file = recordImeReadingEntry(file, { surface: "灯", reading: "あかり" }, "2026-10-24T02:00:00Z");
    expect(file.entries).toEqual([
      { surface: "灯", reading: "あかり", count: 2, lastSeen: "2026-10-24T02:00:00Z" },
    ]);
  });

  test("別の読みが来たら回数の多いほうを主にする", () => {
    let file = empty;
    file = recordImeReadingEntry(file, { surface: "灯", reading: "あかり" }, "2026-10-24T01:00:00Z");
    file = recordImeReadingEntry(file, { surface: "灯", reading: "あかり" }, "2026-10-24T02:00:00Z");
    file = recordImeReadingEntry(file, { surface: "灯", reading: "ともし" }, "2026-10-24T03:00:00Z");
    expect(primaryImeReadings(file).get("灯")).toBe("あかり");
    file = recordImeReadingEntry(file, { surface: "灯", reading: "ともし" }, "2026-10-24T04:00:00Z");
    // 同じ回数なら新しいほう
    expect(primaryImeReadings(file).get("灯")).toBe("ともし");
  });

  test("書いた形を読み戻せる", () => {
    const file = recordImeReadingEntry(empty, { surface: "東雲", reading: "しののめ" }, "2026-10-24T01:00:00Z");
    expect(parseImeReadingFile(JSON.stringify(file))).toEqual(file);
  });

  test("壊れた控えは直さずに投げる", () => {
    expect(() => parseImeReadingFile("{")).toThrow();
    expect(() => parseImeReadingFile(JSON.stringify({ version: 2, entries: [] }))).toThrow();
    expect(() =>
      parseImeReadingFile(JSON.stringify({ version: 1, entries: [{ surface: "灯" }] }))
    ).toThrow();
  });
});

describe("設定資料へ書く／提案にする", () => {
  test("AIが作った項目で読みが空なら埋める", () => {
    expect(decideImeReading({ autoGenerated: true, reading: null }, "あかり")).toBe("fill");
    expect(decideImeReading({ autoGenerated: true, reading: "" }, "あかり")).toBe("fill");
    expect(decideImeReading({ autoGenerated: true, reading: "  " }, "あかり")).toBe("fill");
  });

  test("作者が作った項目には書かず、提案にする", () => {
    expect(decideImeReading({ autoGenerated: false, reading: null }, "あかり")).toBe("suggest");
    expect(decideImeReading({ autoGenerated: false, reading: "ともし" }, "あかり")).toBe("suggest");
  });

  test("別の読みが入っていれば、AIが作った項目でも書かずに提案にする", () => {
    expect(decideImeReading({ autoGenerated: true, reading: "ともし" }, "あかり")).toBe("suggest");
  });

  test("同じ読みなら何もしない（カタカナで入っていても同じとみる）", () => {
    expect(decideImeReading({ autoGenerated: false, reading: "あかり" }, "あかり")).toBe("none");
    expect(decideImeReading({ autoGenerated: true, reading: "アカリ" }, "あかり")).toBe("none");
  });

  test("パネルの提案は名前の読みだけ（別名の読みを名前の読みにしない）", () => {
    const ime = new Map([["灯", "あかり"], ["姫", "ひめ"]]);
    const record = { name: "灯", aliases: ["姫"], autoGenerated: false, reading: null };
    expect(imeSuggestionFor(record, ime)).toBe("あかり");
    expect(imeSuggestionFor({ ...record, name: "灯子" }, ime)).toBeUndefined();
    expect(imeSuggestionFor({ ...record, reading: "あかり" }, ime)).toBeUndefined();
  });
});

describe("読み上げの範囲", () => {
  test("設定資料の読みは名前に、IMEの読みは名前・別名に当てる", () => {
    const ime = new Map([["東雲", "しの"], ["霧ヶ峰", "きりがみね"], ["姫君", "ひめぎみ"]]);
    const readings = nameReadingsFrom(
      [
        { name: "東雲", aliases: ["姫君"], reading: "シノノメ" },
        { name: "霧ヶ峰", aliases: [], reading: null },
      ],
      ime
    );
    expect(readings).toEqual([
      { surface: "東雲", reading: "しののめ" },
      { surface: "姫君", reading: "ひめぎみ" },
      { surface: "霧ヶ峰", reading: "きりがみね" },
    ]);
  });

  test("1字の名前・漢字の無い名前には当てない。長い名前を先に当てる", () => {
    const text = "灯と灯里が東雲へ。リオも。";
    const spans = nameReadingSpans(text, [
      { surface: "灯", reading: "あかり" },
      { surface: "灯里", reading: "あかり" },
      { surface: "東雲", reading: "しののめ" },
      { surface: "リオ", reading: "りお" },
    ]);
    expect(spans.map((span) => text.slice(span.start, span.end))).toEqual(["灯里", "東雲"]);
  });

  test("優先：作者のルビ＞読みの辞書＞設定資料＞IME", () => {
    // 1行目：ルビが振ってある名前／2行目：辞書が文脈つきで読みを決めた名前／3行目：素の名前
    const text = "{東雲|あけぼの}が来た。\n東雲の空。\n東雲と霧ヶ峰。";
    const dictionary = [{ start: 14, end: 16, reading: "とううん" }];
    const names = nameReadingSpans(
      text,
      nameReadingsFrom(
        [
          { name: "東雲", aliases: [], reading: "しののめ" },
          { name: "霧ヶ峰", aliases: [], reading: null },
        ],
        new Map([["東雲", "しの"], ["霧ヶ峰", "きりがみね"]])
      )
    );
    const speech = buildReadingPlan(text, "curly", mergeReadingSpans(dictionary, names)).map(
      (sentence) => sentence.speech
    );
    expect(speech).toEqual(["あけぼのが来た。", "とううんの空。", "しののめときりがみね。"]);
  });

  test("重なる範囲は先の方を残す（写しが壊れない）", () => {
    const merged = mergeReadingSpans(
      [{ start: 2, end: 4, reading: "あ" }],
      [
        { start: 3, end: 5, reading: "い" },
        { start: 0, end: 1, reading: "う" },
      ]
    );
    expect(merged).toEqual([
      { start: 0, end: 1, reading: "う" },
      { start: 2, end: 4, reading: "あ" },
    ]);
  });
});
