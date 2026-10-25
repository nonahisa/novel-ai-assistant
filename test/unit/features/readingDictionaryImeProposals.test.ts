import { beforeEach, describe, expect, test, vi } from "vitest";
import * as vscode from "vscode";

/**
 * 読みの一覧に、IMEで打った読みの提案を出す（設計書6.42.2。作者の裁定、2026-10-25）。
 *
 * 確かめるのは——①列の数（「IMEの読みの提案：N件」）、②［採る］でその話の辞書へ
 * 作者の項目として書く（読み込んだときのハッシュを渡す）、③［見送る］で見送りの印
 * （同期する）へ足し、次から出ない、④控えが壊れていても辞書の一覧と読み上げは続ける。
 */

interface Dict {
  version: 1;
  episode: string;
  entries: Array<{ word: string; quote: string; reading: string; source: "ai" | "author"; removed?: boolean }>;
}

let dictionary: Dict;
const savedDictionaries: Array<{ file: Dict; hash: string | undefined }> = [];
let wordFile: unknown;
let dismissals: { version: 1; entries: Array<{ episode: string; word: string; reading: string; at: string }> };
let wordsBroken = false;

vi.mock("../../../src/core/readingDictionaryStore", () => ({
  episodeRelativePath: () => "01.txt",
  loadReadingDictionary: async () => ({ file: dictionary, hash: "h1" }),
  saveReadingDictionary: async (_w: unknown, _e: unknown, file: Dict, hash: string | undefined) => {
    savedDictionaries.push({ file, hash });
    dictionary = file;
    return "h2";
  },
}));

vi.mock("../../../src/core/imeWordReadingStore", () => ({
  loadImeWordReadings: async () => {
    if (wordsBroken) throw new Error("IMEの読みの提案の控え（imeWordReadings.json）が読めません。");
    return { file: wordFile, hash: undefined };
  },
  loadImeReadingDismissals: async () => ({ file: dismissals, hash: undefined }),
  updateImeReadingDismissals: async (_w: unknown, change: (file: typeof dismissals) => typeof dismissals) => {
    dismissals = change(dismissals);
  },
}));

const doneNotes: string[] = [];
/** 右下の通知に出した文（notifyDone の notes） */
const popupNotes: string[] = [];

vi.mock("../../../src/views/notify", () => ({
  notifyDone: (message: string, notes: readonly string[] = []) => {
    doneNotes.push(message);
    popupNotes.push(...notes);
  },
  warnWithLog: async () => undefined,
}));

import {
  manageReadingDictionary,
  readingDictionarySummary,
} from "../../../src/features/readingDictionary";
import { readingDictionaryNote } from "../../../src/features/manuscriptEditor";
import type { WorkEntry } from "../../../src/models/types";

const work = { id: "w1", folderPath: "/w" } as WorkEntry;
const text = "古い港へ戻った。";
const target = { work, episodePath: "/w/01.txt", text };

beforeEach(() => {
  dictionary = { version: 1, episode: "01.txt", entries: [] };
  savedDictionaries.length = 0;
  wordFile = {
    version: 1,
    entries: [
      {
        episode: "01.txt",
        word: "港",
        reading: "みなと",
        committed: "港へ",
        offset: 0,
        before: "古い",
        count: 1,
        lastSeen: "2026-10-25T01:00:00Z",
      },
    ],
  };
  dismissals = { version: 1, entries: [] };
  wordsBroken = false;
  doneNotes.length = 0;
  popupNotes.length = 0;
  vi.restoreAllMocks();
});

/** 一覧と［採る］／［見送る］の選び方を、順に返す。出た画面の題と案内も控える */
const shownLists: Array<{ title?: string; placeHolder?: string }> = [];
function pickInOrder(...choices: Array<(items: Array<Record<string, unknown>>) => unknown>): void {
  let call = 0;
  shownLists.length = 0;
  vi.spyOn(vscode.window, "showQuickPick").mockImplementation((async (
    items: unknown,
    options?: { title?: string; placeHolder?: string }
  ) => {
    shownLists.push({ title: options?.title, placeHolder: options?.placeHolder });
    const choose = choices[call++];
    if (!choose) return undefined;
    return choose(items as Array<Record<string, unknown>>);
  }) as never);
}

/** 2件目の提案（「戻った」の「戻」→もど）を控えに足す */
function addSecondProposal(): void {
  (wordFile as { entries: unknown[] }).entries.push({
    episode: "01.txt",
    word: "戻",
    reading: "もど",
    committed: "戻った",
    offset: 0,
    before: "古い港へ",
    count: 1,
    lastSeen: "2026-10-25T00:00:00Z",
  });
}

describe("列の数", () => {
  test("提案の数を数え、読み上げには使わない", async () => {
    const summary = await readingDictionarySummary(target);
    expect(summary.imeSuggestions).toBe(1);
    expect(summary.spans).toEqual([]);
    expect(readingDictionaryNote(summary)).toBe("IMEの読みの提案：1件");
  });

  test("辞書の件数の横に出す", () => {
    expect(readingDictionaryNote({ spans: [], active: 2, missing: 0, imeSuggestions: 3 })).toBe(
      "読みの辞書：2件　IMEの読みの提案：3件"
    );
    expect(readingDictionaryNote({ spans: [], active: 2, missing: 0 })).toBe("読みの辞書：2件");
  });

  test("控えが壊れていても、辞書の範囲は返す（読み上げを止めない）", async () => {
    wordsBroken = true;
    dictionary.entries.push({ word: "港", quote: "古い港", reading: "みなと", source: "author" });
    const summary = await readingDictionarySummary(target);
    expect(summary.problem).toBeUndefined();
    expect(summary.imeSuggestions).toBe(0);
    expect(summary.spans).toHaveLength(1);
  });
});

describe("［読みの一覧］で採る・見送る", () => {
  test("提案を先頭に「港 → みなと（IMEで打った読み）」と句で出す", async () => {
    let shown: Array<Record<string, unknown>> = [];
    pickInOrder((items) => {
      shown = items;
      return undefined;
    });
    await manageReadingDictionary(target);
    expect(shown[0].label).toBe("港 → みなと（IMEで打った読み）");
    expect(shown[0].description).toBe("「古い港へ戻った。」");
  });

  test("［採る］で、その話の辞書へ作者の項目として書く（読み込んだときのハッシュを渡す）", async () => {
    pickInOrder(
      (items) => items.find((item) => "proposal" in item),
      (items) => items.find((item) => item.action === "adopt"),
      () => undefined
    );
    expect(await manageReadingDictionary(target)).toBe(true);
    expect(savedDictionaries).toEqual([
      {
        hash: "h1",
        file: {
          version: 1,
          episode: "01.txt",
          entries: [{ word: "港", quote: "古い港へ戻った。", reading: "みなと", source: "author" }],
        },
      },
    ]);
    // 採ったら、次の一覧には提案として出ない
    expect((await readingDictionarySummary(target)).imeSuggestions).toBe(0);
  });

  test("［見送る］で見送りの印へ足し、辞書には書かない。次から出ない", async () => {
    pickInOrder(
      (items) => items.find((item) => "proposal" in item),
      (items) => items.find((item) => item.action === "dismiss"),
      () => undefined
    );
    expect(await manageReadingDictionary(target)).toBe(true);
    expect(savedDictionaries).toEqual([]);
    expect(dismissals.entries).toMatchObject([{ episode: "01.txt", word: "港", reading: "みなと" }]);
    expect((await readingDictionarySummary(target)).imeSuggestions).toBe(0);
  });

  test("［戻る］では何も書かない", async () => {
    pickInOrder(
      (items) => items.find((item) => "proposal" in item),
      (items) => items[items.length - 1],
      () => undefined
    );
    expect(await manageReadingDictionary(target)).toBe(false);
    expect(savedDictionaries).toEqual([]);
    expect(dismissals.entries).toEqual([]);
  });

  test("AIの項目が違う読みなら「AIの読み」を添える", async () => {
    dictionary.entries.push({ word: "港", quote: "港へ戻", reading: "こう", source: "ai" });
    let shown: Array<Record<string, unknown>> = [];
    pickInOrder((items) => {
      shown = items;
      return undefined;
    });
    await manageReadingDictionary(target);
    expect(shown[0].detail).toBe("AIの読み：こう");
  });
});

describe("片づけたあとの戻り方（作者の指摘、2026-10-25 夜）", () => {
  test("最後の1件を採ると、一覧へ戻らずに閉じて「すべて片づきました」と知らせる", async () => {
    pickInOrder(
      (items) => items.find((item) => "proposal" in item),
      (items) => items.find((item) => item.action === "adopt"),
      () => undefined
    );
    expect(await manageReadingDictionary(target)).toBe(true);
    // 一覧 → ［採る］ の2回だけ。3回目の一覧は出ない
    expect(shownLists).toHaveLength(2);
    expect(doneNotes).toEqual(["「港」を読みの辞書に入れました。IMEの読みの提案はすべて片づきました。"]);
    // ステータスバーだけでは気づけない（作者の裁定、2026-10-25 夜「右下の通知に出す」）
    expect(popupNotes).toEqual(["「港」を読みの辞書に入れました。IMEの読みの提案はすべて片づきました。"]);
  });

  test("最後の1件を見送っても、閉じて知らせる", async () => {
    pickInOrder(
      (items) => items.find((item) => "proposal" in item),
      (items) => items.find((item) => item.action === "dismiss"),
      () => undefined
    );
    expect(await manageReadingDictionary(target)).toBe(true);
    expect(shownLists).toHaveLength(2);
    expect(doneNotes).toEqual(["「港」の提案を見送りました。IMEの読みの提案はすべて片づきました。"]);
  });

  test("残りがあれば一覧へ戻り、題にいましたことと残りの件数を出す", async () => {
    addSecondProposal();
    pickInOrder(
      (items) => items.find((item) => item.label === "港 → みなと（IMEで打った読み）"),
      (items) => items.find((item) => item.action === "adopt"),
      () => undefined
    );
    await manageReadingDictionary(target);
    expect(shownLists).toHaveLength(3);
    expect(shownLists[2].title).toBe("「港」を読みの辞書に入れました。IMEの読みの提案：残り1件");
    expect(doneNotes).toEqual([]);
  });

  test("［戻る］で戻ったときは、題に「入れました」を出さない", async () => {
    pickInOrder(
      (items) => items.find((item) => "proposal" in item),
      (items) => items[items.length - 1],
      () => undefined
    );
    await manageReadingDictionary(target);
    expect(shownLists).toHaveLength(3);
    expect(shownLists[2].title).toBe("読みの辞書（0件・IMEの読みの提案1件）");
  });

  test("最初から提案が0件なら、今までどおり辞書の一覧を出す（知らせない）", async () => {
    wordFile = { version: 1, entries: [] };
    dictionary.entries.push({ word: "港", quote: "古い港", reading: "みなと", source: "author" });
    pickInOrder(() => undefined);
    await manageReadingDictionary(target);
    expect(shownLists).toEqual([
      { title: "読みの辞書（1件）", placeHolder: "直したい項目を選んでください" },
    ]);
    expect(doneNotes).toEqual([]);
  });

  test("閉じたあとの列の件数は0件に合う", async () => {
    pickInOrder(
      (items) => items.find((item) => "proposal" in item),
      (items) => items.find((item) => item.action === "adopt")
    );
    await manageReadingDictionary(target);
    const summary = await readingDictionarySummary(target);
    expect(summary.imeSuggestions).toBe(0);
    expect(readingDictionaryNote(summary)).toBe("読みの辞書：1件");
  });
});
