import { describe, expect, test, vi, beforeEach } from "vitest";

/**
 * 提案パネルから本文へ飛ぶ道（作者の報告、2026-08-29）。
 *
 * 「誤字脱字パネルから本文に飛びません」——2.md を**原稿（縦書）で開いて
 * いる状態**で、提案の「2.md 40行目」を押しても何も起きなかった。
 *
 * ## 台帳の鍵
 *
 * 登録側は `document.uri.toString()`、照会側は `paths.toUri(filePath)` から
 * 組み立てた文字列を使っていた。同じファイルでも、Windowsのドライブ文字の
 * 大小や、道の符号化の仕方が経路で違えば一致しない。**開いているのに
 * 「開いていない」と判定され、押しても何も起きない**という終わり方になる。
 * 鍵の作り方を1本にまとめ、そこを固める。
 *
 * ## 開いていないときの受け皿
 *
 * これまでは「いま見ているタブが原稿エディタ」のときしか引き受けなかった。
 * **本文ファイルは原稿エディタ（横書き）で開く**という決まり（作者の指示、
 * 2026-08-29）に合わせ、その原稿が登録作品の話なら横書きで開いて示す。
 * 話でないファイル（プロット・設定資料）は、これまでどおり素のエディタへ譲る。
 */

/** `vscode.commands.executeCommand` に渡されたもの */
const executed: Array<{ command: string; args: unknown[] }> = [];

vi.mock("vscode", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    commands: {
      executeCommand: (command: string, ...args: unknown[]) => {
        executed.push({ command, args });
        return Promise.resolve(undefined);
      },
    },
    window: {
      ...(actual.window as Record<string, unknown>),
      // タブの種類を読めない環境として振る舞わせる（原稿エディタは非アクティブ）。
      // `activeManuscriptViewType` は読めなければ undefined を返す
      showWarningMessage: () => Promise.resolve(undefined),
      showInformationMessage: () => Promise.resolve(undefined),
    },
  };
});

/** 走査が返す話（この作品の本文フォルダーにあるもの） */
let episodes: Array<{ filePath: string }> = [];

vi.mock("../../src/core/scanner", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    scanWork: async () => ({
      episodes,
      stats: {
        fileCount: episodes.length,
        totals: { net: 0, gross: 0, manuscriptLines: 0 },
        conflictedCount: 0,
      },
      manuscriptDir: "C:/小説/いじめられっ子/本文",
    }),
  };
});

import {
  ManuscriptEditorProvider,
  manuscriptLedgerKey,
  type ManuscriptEditorDeps,
} from "../../src/features/manuscriptEditor";
import { MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE } from "../../src/core/manuscriptViewTypes";
import type { WorkEntry } from "../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
  registeredAt: "2026-08-29T00:00:00.000Z",
};

/** その原稿が属する作品を返すか、返さないか */
let belongsToWork = true;

function makeProvider(): ManuscriptEditorProvider {
  const deps = {
    highlighter: {
      indexFor: async () =>
        belongsToWork ? { work, index: { size: 0 } } : undefined,
    },
  } as unknown as ManuscriptEditorDeps;
  return new ManuscriptEditorProvider(deps);
}

const episodePath = "C:/小説/いじめられっ子/本文/2.md";

beforeEach(() => {
  executed.length = 0;
  belongsToWork = true;
  episodes = [{ filePath: episodePath }];
});

describe("台帳の鍵", () => {
  const onWindows = process.platform === "win32";

  test.runIf(onWindows)(
    "区切りとドライブ文字の大小が違っても、同じ鍵になる",
    () => {
      // 登録は文書のURI（`c:\...`）、照会は指摘のパス（`C:/...`）から来る
      expect(manuscriptLedgerKey("C:/小説/いじめられっ子/本文/2.md")).toBe(
        manuscriptLedgerKey("c:\\小説\\いじめられっ子\\本文\\2.md")
      );
    }
  );

  test("ブラウザ版の場所（URI）でも、文字列と同じ鍵になる", () => {
    const location = "vscode-vfs://github/nonahisa/HisasNovels/本文/2.md";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const uri = { scheme: "vscode-vfs", toString: () => location } as any;

    expect(manuscriptLedgerKey(uri)).toBe(manuscriptLedgerKey(location));
  });

  test("別のファイルは、別の鍵になる", () => {
    expect(manuscriptLedgerKey("C:/小説/本文/2.md")).not.toBe(
      manuscriptLedgerKey("C:/小説/本文/3.md")
    );
  });
});

describe("開いていないときの受け皿", () => {
  test("登録作品の話なら、横書きの原稿エディタで開く", async () => {
    await makeProvider().revealLine(episodePath, 40);

    expect(executed).toHaveLength(1);
    expect(executed[0].command).toBe("vscode.openWith");
    expect(executed[0].args[1]).toBe(MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE);
  });

  /** プロット・設定資料は、これまでどおり素のエディタで開く */
  test("作品の話でなければ、引き受けない", async () => {
    episodes = [{ filePath: "C:/小説/いじめられっ子/本文/1.md" }];

    const taken = await makeProvider().revealLine(
      "C:/小説/いじめられっ子/設定/plot.md",
      40
    );

    expect(taken).toBe(false);
    expect(executed).toEqual([]);
  });

  test("作品に属していない原稿も、引き受けない", async () => {
    belongsToWork = false;

    const taken = await makeProvider().revealLine("C:/どこか/memo.md", 1);

    expect(taken).toBe(false);
    expect(executed).toEqual([]);
  });

  /**
   * **開けなかったときは引き受けない。** true を返すと、押しても何も
   * 起きないまま終わる（素のエディタへも行かない）。
   * ここでは `openWith` が実際には開かないので、台帳には載らない。
   */
  test("開けなかったら、素のエディタへ譲る", async () => {
    const taken = await makeProvider().revealLine(episodePath, 40);
    expect(taken).toBe(false);
  });
});
