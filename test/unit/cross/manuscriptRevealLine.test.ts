import { describe, expect, test, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

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

/**
 * 画面の並び（作者の報告、2026-09-19）。
 *
 * **既定は「タブを読めない環境」**——既存の試験はここを見ておらず、
 * 読めないときにこれまでどおり動くことも同時に確かめたい。
 */
const layout = vi.hoisted(() => {
  class TabInputWebview {
    constructor(readonly viewType: string) {}
  }
  /** 原稿エディターのタブ（`uri` は `fromUri` が読める形だけ持たせる） */
  class TabInputCustom {
    readonly uri: { scheme: string; fsPath: string; toString(): string };
    constructor(
      filePath: string,
      readonly viewType: string
    ) {
      this.uri = { scheme: "file", fsPath: filePath, toString: () => filePath };
    }
  }
  return {
    TabInputWebview,
    TabInputCustom,
    groups: undefined as
      | Array<{
          viewColumn: number;
          isActive: boolean;
          activeTab?: { input: unknown };
          tabs: Array<{ input: unknown; isActive?: boolean }>;
        }>
      | undefined,
  };
});

vi.mock("vscode", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    TabInputWebview: layout.TabInputWebview,
    TabInputCustom: layout.TabInputCustom,
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
      get tabGroups() {
        if (!layout.groups) throw new Error("タブを読めない環境");
        return {
          all: layout.groups,
          activeTabGroup: layout.groups.find((group) => group.isActive),
        };
      },
      showWarningMessage: () => Promise.resolve(undefined),
      showInformationMessage: () => Promise.resolve(undefined),
    },
  };
});

/** 走査が返す話（この作品の本文フォルダーにあるもの） */
let episodes: Array<{ filePath: string }> = [];

/**
 * その作品のタイプ（設計書6.70）。**開く向きの既定はここで決まる。**
 * プロットを実際に読ませたいわけではないので、読み取りだけ差し替える。
 */
let workFormat: WorkFormatKey | undefined;

vi.mock("../../../src/core/workFormatStore", () => ({
  readWorkFormat: async () => workFormat,
  invalidateWorkFormat: () => undefined,
  matchWorkFormat: () => undefined,
}));

vi.mock("../../../src/core/scanner", async (importOriginal) => {
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
  waitFor,
  type ManuscriptEditorDeps,
} from "../../../src/features/manuscriptEditor";
import {
  MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE,
  MANUSCRIPT_EDITOR_VIEW_TYPE,
} from "../../../src/core/manuscriptViewTypes";
import type { WorkEntry } from "../../../src/models/types";
import type { WorkFormatKey } from "../../../src/core/workFormat";

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
  workFormat = undefined;
  episodes = [{ filePath: episodePath }];
  layout.groups = undefined;
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

  /**
   * 脚本は縦書きが既定（設計書6.70）。
   *
   * **向きの決め方をここで増やさない。** 作品一覧のクリックと同じ
   * `manuscriptViewTypeFor` に決めさせる。形式が読めない作品は
   * これまでどおり横書きのままである（上のテスト）。
   */
  test("脚本の話は、縦書きの原稿エディタで開く", async () => {
    workFormat = "script";

    await makeProvider().revealLine(episodePath, 40);

    expect(executed).toHaveLength(1);
    expect(executed[0].args[1]).toBe(MANUSCRIPT_EDITOR_VIEW_TYPE);
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

  /**
   * シーンメモのパネルから、まだ開いていない話へ飛んだとき
   * （作者の報告、2026-09-19）。
   *
   * パネルは `ViewColumn.Beside`（原稿の右）に住む。列を渡さないと
   * VS Code は「いま前面の列」＝パネルの列へ原稿を開き、書いていた左の面が
   * 置き去りになる。**避ける先を決めてから開く。**
   */
  test("パネルが前面なら、パネルの列を避けて開く", async () => {
    const panel = { input: new layout.TabInputWebview("novelai.sceneMemos") };
    const left = { input: {} };
    layout.groups = [
      { viewColumn: 1, isActive: false, activeTab: left, tabs: [left] },
      { viewColumn: 2, isActive: true, activeTab: panel, tabs: [panel] },
    ];

    await makeProvider().revealLine(episodePath, 40);

    expect(executed).toHaveLength(1);
    expect(executed[0].args[2]).toBe(1);
  });

  /** 下段の提案パネルから飛ぶ道は、これまでどおり「前面の列」でよい */
  test("前面が編集の面なら、列を指定しない", async () => {
    const left = { input: {} };
    layout.groups = [
      { viewColumn: 1, isActive: true, activeTab: left, tabs: [left] },
    ];

    await makeProvider().revealLine(episodePath, 40);

    expect(executed[0].args[2]).toBeUndefined();
  });

  test("タブを読めない環境でも、これまでどおり開ける", async () => {
    await makeProvider().revealLine(episodePath, 40);

    expect(executed).toHaveLength(1);
    expect(executed[0].args[2]).toBeUndefined();
  });

  test("諦める前に、しばらく待つ", async () => {
    // 待たずに引くと、開いた直後の一瞬だけ「開いていない」になる
    const started = Date.now();
    await makeProvider().revealLine(episodePath, 40);

    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  });
});

/**
 * 同じ話が2枚開き、元の画面が空白になる（作者の報告、2026-10-03。設計書6.25.11）。
 *
 * 校正・メモパネルの行を押すと、左で開いている episode_0001.md があるのに
 * 「台帳にありません」の枝へ降り、もう1枚開いた。台帳から落ちていても、
 * **タブが既にあるなら、そのタブの入口と列で開く**——VS Code は同じ入口・
 * 同じ列の `openWith` を「前に出す」だけで済ませる（1.138.0 で確かめた）。
 * 入口か列が違うと、同じ原稿の2枚目ができる。
 */
describe("タブが既にある原稿へは、もう1枚開かない", () => {
  test("縦書きで開いている話へは、縦書きの入口・その列で開く", async () => {
    const manuscript = {
      input: new layout.TabInputCustom(episodePath, MANUSCRIPT_EDITOR_VIEW_TYPE),
      isActive: true,
    };
    const panel = {
      input: new layout.TabInputWebview("novelai.sceneMemos"),
      isActive: true,
    };
    layout.groups = [
      { viewColumn: 1, isActive: false, activeTab: manuscript, tabs: [manuscript] },
      { viewColumn: 2, isActive: true, activeTab: panel, tabs: [panel] },
    ];

    await makeProvider().revealLine(episodePath, 158);

    expect(executed).toHaveLength(1);
    expect(executed[0].args[1]).toBe(MANUSCRIPT_EDITOR_VIEW_TYPE);
    expect(executed[0].args[2]).toBe(1);
  });

  test("パネルを避けた先ではなく、原稿が居る列で開く", async () => {
    const text = { input: {}, isActive: true };
    const panel = {
      input: new layout.TabInputWebview("novelai.sceneMemos"),
      isActive: true,
    };
    const manuscript = {
      input: new layout.TabInputCustom(
        episodePath,
        MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE
      ),
      isActive: true,
    };
    layout.groups = [
      { viewColumn: 1, isActive: false, activeTab: text, tabs: [text] },
      { viewColumn: 2, isActive: true, activeTab: panel, tabs: [panel] },
      { viewColumn: 3, isActive: false, activeTab: manuscript, tabs: [manuscript] },
    ];

    await makeProvider().revealLine(episodePath, 158);

    expect(executed).toHaveLength(1);
    expect(executed[0].args[1]).toBe(MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE);
    expect(executed[0].args[2]).toBe(3);
  });

  test("別の話のタブは見ない（これまでどおりの開き方）", async () => {
    const other = {
      input: new layout.TabInputCustom(
        "C:/小説/いじめられっ子/本文/1.md",
        MANUSCRIPT_EDITOR_VIEW_TYPE
      ),
      isActive: true,
    };
    layout.groups = [
      { viewColumn: 1, isActive: false, activeTab: other, tabs: [other] },
    ];

    await makeProvider().revealLine(episodePath, 40);

    expect(executed).toHaveLength(1);
    expect(executed[0].args[1]).toBe(MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE);
  });

  /**
   * 台帳そのものの直し（鍵1つに面をいくつも載せる）は `core/keyedLedger.test.ts`。
   * ここでは、原稿エディターがその台帳を使い、閉じた面だけを外すことを見る。
   * `resolveCustomTextEditor` を代役で組むには依存が多すぎるので、源の形で見張る
   */
  test("台帳は同じ原稿の面をいくつも持ち、閉じた面だけを外す", () => {
    const source = readFileSync("src/features/manuscriptEditor.ts", "utf8");
    expect(source).toContain("new KeyedLedger<");
    expect(source).toContain("openManuscripts.remove(key, entry)");
    // 鍵ごと消す書き方へ戻さない（2枚目を閉じると1枚目が台帳から落ちる）
    expect(source).not.toContain("openManuscripts.delete(key)");
  });
});

/**
 * 台帳に載るのを待つ（作者の報告「誤字脱字パネルから本文に飛びません」の
 * 残り半分）。
 *
 * **`vscode.openWith` の完了は、台帳に載ったことを意味しない。**
 * 台帳へ載せるのは `resolveCustomTextEditor` で、そちらは非同期に走る。
 * 待たずに引くと「開いていない」と読めてしまい、呼び出し側が同じ原稿を
 * **素のエディタでも開く**（1つの原稿が2つの面で開く）。
 */
describe("載るまで待つ", () => {
  test("すぐ取れれば、待たない", async () => {
    const started = Date.now();

    await expect(waitFor(() => "載っている", 1000)).resolves.toBe("載っている");
    expect(Date.now() - started).toBeLessThan(200);
  });

  test("少し遅れて載ったものを拾う", async () => {
    let value: string | undefined;
    setTimeout(() => {
      value = "あとから載った";
    }, 120);

    await expect(waitFor(() => value, 1000, 20)).resolves.toBe("あとから載った");
  });

  test("上限まで載らなければ諦める（素のエディタへ譲る）", async () => {
    const started = Date.now();

    await expect(waitFor(() => undefined, 150, 20)).resolves.toBeUndefined();
    // **必ず待ってから諦める**（0で戻ると、直す前と同じことになる）
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });
});

/**
 * `.md` にしたら、元の `.txt` の面を閉じる。
 *
 * 閉じずに残すと、作者がそのタブへ戻って打ち、保存した瞬間に
 * **消えたはずの .txt が復活する**（VS Code は無くなったファイルへも
 * 保存できる）。同じ話が .txt と .md の2つになり、以後どちらが本物か
 * 分からなくなる。
 */
describe(".md 化のあとの後片付け", () => {
  const source = readFileSync("src/features/manuscriptEditor.ts", "utf8");
  const suggest = source.slice(
    source.indexOf("private async suggestMarkdown"),
    source.indexOf("private async insertRuby")
  );

  /*
    **0.75.4 で、閉じる場所が変換の側へ移った。**

    ここで閉じていたときは、**促しから変換したときだけ**面が閉じ、詳細メニューや
    右クリックからの変換では残っていた。いまは変換の唯一の口
    （`markdownConvert.renamePreservingContent`）が閉じる。
    閉じ方・閉じる時点・未保存の扱いは `renameClosesManuscript.test.ts` が見る。
  */
  test("促しは変換を通す（そこで元の面が閉じる）", () => {
    expect(suggest).toContain("this.deps.convertToMarkdown(filePath)");
    // 断られた・失敗したときは、そもそも変換していないので面も残る
    expect(suggest).toContain("if (!converted) return;");
  });

  test("促し側に写しを残さない（始末は1か所）", () => {
    expect(suggest).not.toContain("panel.dispose()");
  });
});
