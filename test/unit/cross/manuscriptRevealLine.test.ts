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
    /** モーダルの答え（先頭から順に返す。尽きたら Esc＝undefined） */
    answers: [] as Array<string | undefined>,
    /** 出たモーダル・知らせ（文と詳しい文とボタン） */
    shown: [] as Array<{ message: string; detail?: string; items: string[] }>,
    /** 閉じたタブ */
    closed: [] as unknown[],
    /** タブを閉じられたか（保存の確認で取りやめた等なら false） */
    closeResult: true,
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
          close: (tab: unknown) => {
            layout.closed.push(tab);
            if (layout.closeResult && layout.groups) {
              for (const group of layout.groups) {
                group.tabs = group.tabs.filter((one) => one !== tab);
              }
            }
            return Promise.resolve(layout.closeResult);
          },
        };
      },
      showWarningMessage: (message: string, ...rest: unknown[]) => {
        const options = rest[0] as { detail?: string } | undefined;
        layout.shown.push({
          message,
          detail: options?.detail,
          items: rest.filter((item): item is string => typeof item === "string"),
        });
        return Promise.resolve(layout.answers.shift());
      },
      showInformationMessage: (message: string, ...rest: unknown[]) => {
        const options = rest[0] as { detail?: string } | undefined;
        layout.shown.push({
          message,
          detail: options?.detail,
          items: rest.filter((item): item is string => typeof item === "string"),
        });
        return Promise.resolve(layout.answers.shift());
      },
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
  CLOSE_AND_REOPEN_ITEM,
  COPIED_CLOSE_AND_REOPEN_ITEM,
  ManuscriptEditorProvider,
  RELOAD_WINDOW_ITEM,
  manuscriptLedgerKey,
  waitFor,
  type ManuscriptEditorDeps,
} from "../../../src/features/manuscriptEditor";
import { MANUSCRIPT_RELOAD_JUMP_STATE_KEY } from "../../../src/core/manuscriptReloadJump";
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

/** 作業場の覚え（workspaceState の代役）。再読み込みをまたぐ頼みが入る */
const memo = new Map<string, unknown>();

function makeProvider(): ManuscriptEditorProvider {
  const deps = {
    highlighter: {
      indexFor: async () =>
        belongsToWork ? { work, index: { size: 0 } } : undefined,
    },
    reloadJumps: {
      get: (name: string) => memo.get(name),
      update: (name: string, value: unknown) => {
        if (value === undefined) memo.delete(name);
        else memo.set(name, value);
        return Promise.resolve();
      },
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
  layout.answers = [];
  layout.shown = [];
  layout.closed = [];
  layout.closeResult = true;
  memo.clear();
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

  /**
   * 拡張機能ホストを起動し直した直後（作者の実機、2026-10-03）。新しいホストの
   * 台帳は空で、左の面はつながっていない。行を押しても、左のタブを前に出す
   * だけにし、パネルの列へ新しい面を作らない。
   *
   * 左の面がつながらないときは**素のエディタへ譲らない**（作者の裁定 2026-10-15。
   * 譲ると同じ話の2枚目ができる）。どうするかを作者に訊く（下の describe）。
   * 取りやめ（Esc）なら何もしない
   */
  test("起動し直した直後（台帳が空）でも、同じ入口のタブを前に出すだけ", async () => {
    layout.groups = disconnectedLayout().groups;

    const taken = await makeProvider().revealLine(episodePath, 210);

    // openWith は1回だけ、左のタブの入口と列で（＝前に出す）
    expect(executed).toHaveLength(1);
    expect(executed[0].command).toBe("vscode.openWith");
    expect(executed[0].args[1]).toBe(MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE);
    expect(executed[0].args[2]).toBe(1);
    // 取りやめたので、素のエディタでも開かない（引き受けたことにする）
    expect(taken).toBe(true);
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
 * 左の列に、つながりの切れた横書きの原稿のタブ。右の列に校正・メモパネル。
 * 新しい拡張機能の台帳は空（拡張機能ホストを起動し直した直後の形）
 */
function disconnectedLayout() {
  const manuscript = {
    input: new layout.TabInputCustom(
      episodePath,
      MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE
    ),
    isActive: true,
  };
  const panel = {
    input: new layout.TabInputWebview("novelai.sceneMemos"),
    isActive: true,
  };
  return {
    manuscript,
    groups: [
      { viewColumn: 1, isActive: false, activeTab: manuscript, tabs: [manuscript] },
      { viewColumn: 2, isActive: true, activeTab: panel, tabs: [panel] },
    ],
  };
}

/**
 * 飛び先の原稿の画面が、拡張機能ホストの再起動でつながりの切れたものだったとき
 * （作者の裁定 2026-10-15。設計書6.25.11）。
 *
 * これまでは素のエディタへ譲り、同じ話の2枚目ができていた。**切れた画面の控え
 * （届いていなかった字）は画面の中にしか無く、タブを閉じると消える**ので、
 * 黙って閉じない。作者に訊く——既定は［ウィンドウを再読み込み］（控えが残る。
 * 再読み込みのあと、その行を示す）。閉じて開き直す道は、作者が控えを
 * コピーしたと答えてから通す。
 */
describe("つながりの切れた画面へ飛ぶとき", () => {
  test("素のエディタへ譲らず、作者に訊く（既定は再読み込み）", async () => {
    layout.groups = disconnectedLayout().groups;

    await makeProvider().revealLine(episodePath, 210);

    expect(layout.shown).toHaveLength(1);
    expect(layout.shown[0].items[0]).toBe(RELOAD_WINDOW_ITEM);
    expect(layout.shown[0].items).toContain(CLOSE_AND_REOPEN_ITEM);
    // 何行目へ飛ぶつもりかと、閉じると控えが消えることを伝える
    expect(layout.shown[0].detail).toContain("210行目");
    expect(layout.shown[0].detail).toContain("消え");
  });

  test("［ウィンドウを再読み込み］なら、行を覚えてから再読み込みする", async () => {
    layout.groups = disconnectedLayout().groups;
    layout.answers = [RELOAD_WINDOW_ITEM];

    const taken = await makeProvider().revealLine(episodePath, 210);

    expect(taken).toBe(true);
    expect(executed.map((one) => one.command)).toEqual([
      "vscode.openWith",
      "workbench.action.reloadWindow",
    ]);
    const saved = memo.get(MANUSCRIPT_RELOAD_JUMP_STATE_KEY) as
      | { key: string; line: number }
      | undefined;
    expect(saved?.key).toBe(manuscriptLedgerKey(episodePath));
    expect(saved?.line).toBe(210);
    // タブは閉じない（控えが消える）
    expect(layout.closed).toEqual([]);
  });

  test("［閉じて開き直す］の1回目は閉じず、先にコピーするよう頼む", async () => {
    layout.groups = disconnectedLayout().groups;
    layout.answers = [CLOSE_AND_REOPEN_ITEM];

    const taken = await makeProvider().revealLine(episodePath, 210);

    expect(taken).toBe(true);
    expect(layout.closed).toEqual([]);
    expect(executed.map((one) => one.command)).toEqual(["vscode.openWith"]);
    // 2つ目の知らせで、［本文をコピー］を押してからもう一度選ぶよう頼む
    expect(layout.shown).toHaveLength(2);
    expect(`${layout.shown[1].message}${layout.shown[1].detail ?? ""}`).toContain("［本文をコピー］");
  });

  test("コピーを頼んだあとは、閉じて同じ列・同じ入口で開き直す", async () => {
    const provider = makeProvider();
    const { manuscript, groups } = disconnectedLayout();
    layout.groups = groups;
    layout.answers = [CLOSE_AND_REOPEN_ITEM];
    await provider.revealLine(episodePath, 210);

    executed.length = 0;
    layout.shown = [];
    layout.answers = [COPIED_CLOSE_AND_REOPEN_ITEM];
    await provider.revealLine(episodePath, 210);

    // 2回目の問いでは「コピーした」と答えられる
    expect(layout.shown[0].items).toContain(COPIED_CLOSE_AND_REOPEN_ITEM);
    expect(layout.closed).toEqual([manuscript]);
    const reopen = executed.filter((one) => one.command === "vscode.openWith");
    // 1回目は切れたタブを前に出す。2回目が開き直し（同じ入口・同じ列）
    expect(reopen).toHaveLength(2);
    expect(reopen[1].args[1]).toBe(MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE);
    expect(reopen[1].args[2]).toBe(1);
    // 再読み込みはしない
    expect(executed.map((one) => one.command)).not.toContain(
      "workbench.action.reloadWindow"
    );
  });

  test("タブを閉じられなかったら（保存の確認で取りやめた等）、開き直さない", async () => {
    const provider = makeProvider();
    layout.groups = disconnectedLayout().groups;
    layout.answers = [CLOSE_AND_REOPEN_ITEM];
    await provider.revealLine(episodePath, 210);
    executed.length = 0;
    layout.closeResult = false;
    layout.answers = [COPIED_CLOSE_AND_REOPEN_ITEM];

    const taken = await provider.revealLine(episodePath, 210);

    expect(taken).toBe(true);
    expect(layout.closed).toHaveLength(1);
    // 前に出す1回だけ。開き直しの openWith は呼ばない
    expect(executed.map((one) => one.command)).toEqual(["vscode.openWith"]);
  });

  test("取りやめ（Esc）なら、何もしない", async () => {
    layout.groups = disconnectedLayout().groups;

    const taken = await makeProvider().revealLine(episodePath, 210);

    expect(taken).toBe(true);
    expect(layout.closed).toEqual([]);
    expect(memo.size).toBe(0);
    expect(executed.map((one) => one.command)).toEqual(["vscode.openWith"]);
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
