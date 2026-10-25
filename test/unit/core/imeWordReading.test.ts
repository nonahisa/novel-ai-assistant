import { describe, expect, test } from "vitest";
import {
  adoptImeWordProposal,
  captureImeWords,
  dismissImeWord,
  IME_WORD_BEFORE_MAX,
  imeWordProposals,
  judgeImeWord,
  parseImeWordDismissalFile,
  parseImeWordReadingFile,
  phraseForImeWord,
  recordImeWordEntries,
  splitImeWords,
  type ImeWordDismissalFile,
  type ImeWordReadingEntry,
  type ImeWordReadingFile,
} from "../../../src/core/imeWordReading";
import {
  mergeReadingEntries,
  readingSpansFor,
  type ReadingEntry,
} from "../../../src/core/readingDictionary";

/**
 * IMEで打った読みを、名前以外の語でも読みの辞書への提案にする（設計書6.42.2。
 * 作者の裁定、2026-10-25）。きっかけは、読み上げが「港」を「こう」と読んだこと
 * （打った読みは「みなと」）。
 *
 * 確かめるのは——①確定を語へ割る（割り方が1通りのときだけ）、②読みが2通り以上
 * ある語だけを候補にする（同梱の常用漢字の音訓表で見る）、③句をいまの本文から
 * 求める、④辞書と突き合わせる（作者の項目を押しのけない）、⑤［採る］と［見送る］。
 */

describe("確定を語へ割る", () => {
  test("港へ → 港／みなと（後ろのかなは読みにも同じかながある）", () => {
    expect(splitImeWords("みなとへ", "港へ")).toEqual([
      { run: "港", reading: "みなと", offset: 0, following: "へ" },
    ]);
  });

  test("文節まるごと：港へ行く → 港（みなと）と 行（い、後ろに く）", () => {
    expect(splitImeWords("みなとへいく", "港へ行く")).toEqual([
      { run: "港", reading: "みなと", offset: 0, following: "へ" },
      { run: "行", reading: "い", offset: 2, following: "く" },
    ]);
  });

  test("カタカナの字は、ひらがなの読みと照らす", () => {
    expect(splitImeWords("こーひーてん", "コーヒー店")).toEqual([
      { run: "店", reading: "てん", offset: 4, following: "" },
    ]);
  });

  test("割り方が2通りあれば捨てる", () => {
    // 「の」が読みに2回ある：葉＝は／葉＝はのはの…と、木の読みが決まらない
    expect(splitImeWords("このはのは", "木の葉")).toBeUndefined();
  });

  test("かなの並びが読みに無ければ捨てる", () => {
    expect(splitImeWords("みなとに", "港へ")).toBeUndefined();
  });

  test("句読点・英数を含む確定は捨てる（どこまでが読みか決まらない）", () => {
    expect(splitImeWords("みなとへ", "港へ。")).toBeUndefined();
    expect(splitImeWords("えーみなと", "A港")).toBeUndefined();
  });

  test("漢字が無い確定は語にならない", () => {
    expect(splitImeWords("みなと", "ミナト")).toEqual([]);
  });
});

describe("読みが2通り以上ある語だけを候補にする", () => {
  const judge = (kana: string, committed: string) =>
    captureImeWords(kana, committed, []).map((item) => `${item.word}/${item.reading}`);

  test("港（みなと）○——表に こう・みなと の2つ", () => {
    expect(judge("みなと", "港")).toEqual(["港/みなと"]);
  });

  test("行く（いく）○——語の形（〜く）に合う訓が いく・ゆく の2つ。語は送り仮名込み", () => {
    expect(judge("いく", "行く")).toEqual(["行く/いく"]);
  });

  test("言う×・思う×・見る×（語の形に合う読みが1つ）", () => {
    expect(judge("いう", "言う")).toEqual([]);
    expect(judge("おもう", "思う")).toEqual([]);
    // 表の訓は みる・みえる・みせる。みえる・みせる は「見える」「見せる」の形なので数えない
    expect(judge("みる", "見る")).toEqual([]);
  });

  test("学校（がっこう）×——音読みをつないだだけ", () => {
    expect(judge("がっこう", "学校")).toEqual([]);
  });

  test("今日（きょう）○——音読みをつないだ形でない", () => {
    expect(judge("きょう", "今日")).toEqual(["今日/きょう"]);
  });

  test("打った読みが表に無ければ候補（止める＝やめる）", () => {
    expect(judge("やめる", "止める")).toEqual(["止める/やめる"]);
  });

  test("活用した形（見た・行った）は判定できないので候補にしない", () => {
    expect(judge("みた", "見た")).toEqual([]);
    expect(judge("いった", "行った")).toEqual([]);
  });

  test("港へ行く → 港と行く の両方", () => {
    expect(judge("みなとへいく", "港へ行く")).toEqual(["港/みなと", "行く/いく"]);
  });

  test("名前に当たった表記は除く", () => {
    expect(captureImeWords("みなとへ", "港へ", ["港"])).toEqual([]);
    expect(captureImeWords("しらかばへいく", "白樺へ行く", ["白樺"]).map((w) => w.word)).toEqual([
      "行く",
    ]);
  });

  test("判定の部品を単独で：表に無い字は候補", () => {
    expect(judgeImeWord("嘘", "うそ", "")).toEqual({ word: "嘘", reading: "うそ" });
  });
});

describe("控えの形", () => {
  test("同じ（話・語・読み）は回数を足し、直前の字と確定を新しくする", () => {
    const empty: ImeWordReadingFile = { version: 1, entries: [] };
    const first = recordImeWordEntries(empty, {
      episode: "01.txt",
      captures: [{ word: "港", reading: "みなと", offset: 0 }],
      committed: "港へ",
      before: "古い",
      now: "2026-10-25T01:00:00Z",
    });
    expect(first.added).toEqual([{ word: "港", reading: "みなと" }]);
    const second = recordImeWordEntries(first.file, {
      episode: "01.txt",
      captures: [{ word: "港", reading: "みなと", offset: 0 }],
      committed: "港に",
      before: "新しい",
      now: "2026-10-25T02:00:00Z",
    });
    expect(second.added).toEqual([]);
    expect(second.file.entries).toEqual([
      {
        episode: "01.txt",
        word: "港",
        reading: "みなと",
        committed: "港に",
        offset: 0,
        before: "新しい",
        count: 2,
        lastSeen: "2026-10-25T02:00:00Z",
      },
    ]);
  });

  test("直前の字は末尾の上限までにする", () => {
    const { file } = recordImeWordEntries(
      { version: 1, entries: [] },
      {
        episode: "01.txt",
        captures: [{ word: "港", reading: "みなと", offset: 0 }],
        committed: "港",
        before: "あ".repeat(40),
        now: "2026-10-25T01:00:00Z",
      }
    );
    expect(file.entries[0].before).toHaveLength(IME_WORD_BEFORE_MAX);
  });

  test("壊れた控え・見送りの印は直さずに投げる", () => {
    expect(() => parseImeWordReadingFile("{")).toThrow();
    expect(() => parseImeWordReadingFile('{"version":1,"entries":[{"word":1}]}')).toThrow();
    expect(() => parseImeWordDismissalFile('{"version":2,"entries":[]}')).toThrow();
  });

  test("書いた形を読み戻せる", () => {
    const { file } = recordImeWordEntries(
      { version: 1, entries: [] },
      {
        episode: "01.txt",
        captures: [{ word: "港", reading: "みなと", offset: 0 }],
        committed: "港",
        before: "",
        now: "2026-10-25T01:00:00Z",
      }
    );
    expect(parseImeWordReadingFile(JSON.stringify(file))).toEqual(file);
    const dismissed = dismissImeWord(
      { version: 1, entries: [] },
      { episode: "01.txt", word: "港", reading: "みなと" },
      "2026-10-25T03:00:00Z"
    );
    expect(parseImeWordDismissalFile(JSON.stringify(dismissed))).toEqual(dismissed);
  });
});

function entry(extra: Partial<ImeWordReadingEntry> = {}): ImeWordReadingEntry {
  return {
    episode: "01.txt",
    word: "港",
    reading: "みなと",
    committed: "港へ",
    offset: 0,
    before: "古い",
    count: 1,
    lastSeen: "2026-10-25T01:00:00Z",
    ...extra,
  };
}

describe("句をいまの本文から求める", () => {
  test("控えた直前の字で終わる所を優先する", () => {
    const text = "新しい港へ向かう。\n古い港へ戻った。";
    const phrase = phraseForImeWord(text, entry());
    expect(phrase?.quote).toBe("古い港へ戻った。");
    expect(text.slice(phrase!.wordStart, phrase!.wordStart + 1)).toBe("港");
    expect(phrase!.wordStart).toBe(text.lastIndexOf("港"));
  });

  test("直前の字が合わなくても（ルビの読みが混じった等）、1か所だけなら採る", () => {
    const text = "古い｜港《みなと》のそばで、港へ急いだ。";
    const phrase = phraseForImeWord(text, entry({ before: "古いみなと" }));
    expect(phrase?.wordStart).toBe(text.indexOf("港へ"));
  });

  test("直前の字が合わず2か所以上あれば出さない", () => {
    const text = "港へ行く。\n港へ戻る。";
    expect(phraseForImeWord(text, entry({ before: "ちがう" }))).toBeUndefined();
  });

  test("行頭で打った（直前の字が空）なら、行頭の所だけを見る", () => {
    const text = "あの港へ。\n港へ向かう。";
    const phrase = phraseForImeWord(text, entry({ before: "" }));
    expect(phrase?.wordStart).toBe(text.indexOf("\n") + 1);
  });

  test("句は行の中だけ・30字以内・語より長い", () => {
    const long = "あ".repeat(40);
    const text = `${long}古い港へ${long}\n次の行`;
    const phrase = phraseForImeWord(text, entry());
    expect(phrase).toBeDefined();
    expect(phrase!.quote.length).toBeLessThanOrEqual(30);
    expect(phrase!.quote).not.toContain("\n");
    expect(phrase!.quote).toContain("港");
    expect(phrase!.quote.length).toBeGreaterThan(1);
  });

  test("語だけの行では句が作れないので出さない", () => {
    expect(phraseForImeWord("前の行\n港\n後の行", entry({ committed: "港", before: "" }))).toBeUndefined();
  });

  test("句の中で語が先に出ないようにする（辞書は句の中の最初の所に読みを当てる）", () => {
    const text = "港から古い港へ戻った。";
    const phrase = phraseForImeWord(text, entry());
    expect(phrase).toBeDefined();
    expect(phrase!.quote.indexOf("港")).toBe(phrase!.wordStart - text.indexOf(phrase!.quote));
    // 辞書へ入れたら、打った所に読みが当たる
    const spans = readingSpansFor(text, [
      { word: "港", quote: phrase!.quote, reading: "みなと", source: "author" },
    ]).spans;
    expect(spans).toEqual([{ start: phrase!.wordStart, end: phrase!.wordStart + 1, reading: "みなと" }]);
  });
});

describe("辞書と突き合わせる", () => {
  const text = "古い港へ戻った。";
  const none: ImeWordDismissalFile = { version: 1, entries: [] };
  const propose = (dictionary: ReadingEntry[], dismissals = none) =>
    imeWordProposals({
      entries: [entry()],
      dismissals,
      dictionary,
      episode: "01.txt",
      text,
    });

  test("辞書に何も無ければ出す", () => {
    expect(propose([])).toEqual([
      { word: "港", reading: "みなと", quote: "古い港へ戻った。", wordStart: 2, count: 1 },
    ]);
  });

  test("ほかの話の控えは出さない", () => {
    expect(
      imeWordProposals({ entries: [entry({ episode: "02.txt" })], dismissals: none, dictionary: [], episode: "01.txt", text })
    ).toEqual([]);
  });

  test("作者の項目がその所にあれば出さない（実装ルール2）", () => {
    expect(
      propose([{ word: "港", quote: "古い港", reading: "こう", source: "author" }])
    ).toEqual([]);
  });

  test("作者が消した印があれば出さない", () => {
    expect(
      propose([{ word: "港", quote: "古い港", reading: "こう", source: "author", removed: true }])
    ).toEqual([]);
  });

  test("AIの項目が同じ読みなら出さない", () => {
    expect(propose([{ word: "港", quote: "港へ戻", reading: "みなと", source: "ai" }])).toEqual([]);
  });

  test("AIの項目が違う読みなら、AIの読みを添えて出す", () => {
    expect(propose([{ word: "港", quote: "港へ戻", reading: "こう", source: "ai" }])).toEqual([
      {
        word: "港",
        reading: "みなと",
        quote: "古い港へ戻った。",
        wordStart: 2,
        count: 1,
        aiReading: "こう",
      },
    ]);
  });

  test("見送った（話・語・読み）は出さない", () => {
    const dismissed = dismissImeWord(none, { episode: "01.txt", word: "港", reading: "みなと" }, "t");
    expect(propose([], dismissed)).toEqual([]);
    // 別の話で見送っていても、この話では出す
    const other = dismissImeWord(none, { episode: "02.txt", word: "港", reading: "みなと" }, "t");
    expect(propose([], other)).toHaveLength(1);
  });
});

describe("［採る］", () => {
  const proposal = {
    word: "港",
    reading: "みなと",
    quote: "古い港へ戻った。",
    wordStart: 2,
    count: 1,
  };

  test("作者の項目として入れ、同じ語・句のAIの項目は置き換える", () => {
    const current: ReadingEntry[] = [
      { word: "港", quote: "古い港へ戻った。", reading: "こう", source: "ai" },
      { word: "音", quote: "音がした", reading: "おと", source: "ai" },
    ];
    expect(adoptImeWordProposal(current, proposal)).toEqual([
      { word: "港", quote: "古い港へ戻った。", reading: "みなと", source: "author" },
      { word: "音", quote: "音がした", reading: "おと", source: "ai" },
    ]);
  });

  test("採った項目は、AIで作り直しても残る", () => {
    const adopted = adoptImeWordProposal([], proposal);
    const fresh: ReadingEntry[] = [
      { word: "港", quote: "古い港へ戻った。", reading: "こう", source: "ai" },
    ];
    expect(mergeReadingEntries(adopted, fresh)).toEqual([
      { word: "港", quote: "古い港へ戻った。", reading: "みなと", source: "author" },
    ]);
  });
});
