import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * シーンメモの行を挿すところ（設計書6.40.3）と、
 * 読み上げの「引っかかった」（設計書6.42）が分け合う道。
 *
 * **中身は省略できる引数で渡す。** 挿し方を2つに分けると、片方だけが
 * 「カーソル行の上に置く」「本文の書き換えは WorkspaceEdit を通す」という
 * 決まりから外れる日が来る。
 */

/** `WorkspaceEdit.insert` に渡されたもの */
const inserted: Array<{ line: number; character: number; text: string }> = [];
/** その書き換えが当たったか */
let applied = true;

vi.mock("vscode", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;

  class Position {
    constructor(
      readonly line: number,
      readonly character: number
    ) {}
  }

  class WorkspaceEdit {
    insert(_uri: unknown, position: Position, text: string): void {
      inserted.push({
        line: position.line,
        character: position.character,
        text,
      });
    }
  }

  return {
    ...actual,
    Position,
    WorkspaceEdit,
    workspace: {
      ...(actual.workspace as Record<string, unknown>),
      applyEdit: async () => applied,
    },
    window: {
      ...(actual.window as Record<string, unknown>),
      showWarningMessage: () => Promise.resolve(undefined),
    },
  };
});

import {
  insertMemoLineAbove,
  isInsideWork,
} from "../../src/features/manuscriptEditor";
import { READ_ALOUD_MEMO_TEXT } from "../../src/core/readAloud";
import { isMemoLine, parseMemos } from "../../src/core/sceneMemo";

/** 行数だけを持つ、偽の文書（挿す位置の計算にしか使わない） */
function fakeDocument(lineCount: number): Parameters<
  typeof insertMemoLineAbove
>[0] {
  return {
    uri: { fsPath: "C:/小説/本文/1.md", toString: () => "file:///1.md" },
    lineCount,
  } as unknown as Parameters<typeof insertMemoLineAbove>[0];
}

beforeEach(() => {
  inserted.length = 0;
  applied = true;
});

describe("付箋の行を挿す", () => {
  test("中身を省くと、いままでどおり空の付箋になる", async () => {
    expect(await insertMemoLineAbove(fakeDocument(10), 4)).toBe(true);

    expect(inserted).toEqual([
      // 1始まりの4行目 → 0始まりの3行目の頭に挿す（＝その行の「上」）
      { line: 3, character: 0, text: "// \n" },
    ]);
  });

  test("中身を渡すと、印のあとに入る", async () => {
    await insertMemoLineAbove(fakeDocument(10), 4, {
      body: READ_ALOUD_MEMO_TEXT,
    });

    expect(inserted[0].text).toBe("// " + READ_ALOUD_MEMO_TEXT + "\n");
  });

  /**
   * **挿した行が付箋として読まれること**が要件である
   * （読まれなければ、シーンメモのパネルにも一覧にも出てこない）。
   */
  test("挿した行は、シーンメモとして読まれる", async () => {
    await insertMemoLineAbove(fakeDocument(10), 1, {
      body: READ_ALOUD_MEMO_TEXT,
    });
    const line = inserted[0].text.replace("\n", "");

    expect(isMemoLine(line)).toBe(true);
    expect(parseMemos(line, "1.md")).toHaveLength(1);
  });

  test("読めない行番号は、先頭に置く", async () => {
    await insertMemoLineAbove(fakeDocument(10), Number.NaN);

    expect(inserted[0].line).toBe(0);
  });

  test("行数を超えた番号は、最後の行に収める", async () => {
    await insertMemoLineAbove(fakeDocument(3), 99);

    expect(inserted[0].line).toBe(2);
  });

  /** 当たらなかったときに true を返すと、押しても何も起きないまま終わる */
  test("当てられなければ false", async () => {
    applied = false;

    expect(await insertMemoLineAbove(fakeDocument(10), 2)).toBe(false);
  });
});

/**
 * 読み上げる原稿を決めるときの濾し（レビュー指摘、2026-08-29。設計書6.42）。
 *
 * **候補は3つとも作品の外を指しうる。** 原稿エディタの台帳は作品をまたいで
 * 覚えているし、素のエディタで開いているファイルは拡張子しか見ていない。
 * 濾さないと、READMEや設計書を読み上げることになる。
 */
describe("作品の中のファイルか", () => {
  const work = "C:/小説/いじめられっ子";

  test("作品の中のファイルなら true", () => {
    expect(isInsideWork(work, "C:/小説/いじめられっ子/本文/2.md")).toBe(true);
  });

  test("別の作品のファイルなら false", () => {
    expect(isInsideWork(work, "C:/小説/別の作品/本文/1.md")).toBe(false);
    // 名前が前方一致するだけの別フォルダーも、中ではない
    expect(isInsideWork(work, "C:/小説/いじめられっ子2/本文/1.md")).toBe(false);
    // 作品より上にある文書（READMEや設計書）も外
    expect(isInsideWork(work, "C:/小説/README.md")).toBe(false);
  });

  test("作品そのもの（同じ道）は、読む本文ではないので false", () => {
    expect(isInsideWork(work, work)).toBe(false);
  });

  /** 区切りとドライブ文字の大小は、経路によって違う（設計書5.8） */
  test("区切りや大小が違っても、中だと分かる", () => {
    const onWindows = process.platform === "win32";
    expect(
      isInsideWork(work, "c:\\小説\\いじめられっ子\\本文\\2.md")
    ).toBe(onWindows);
  });

  test("空の道は外として扱う", () => {
    expect(isInsideWork(work, "")).toBe(false);
    expect(isInsideWork("", "C:/小説/1.md")).toBe(false);
  });
});
