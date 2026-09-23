import { describe, expect, test, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 原稿エディタで開いている本文を、コマンドから見つけられるようにする
 * （作者の実機報告、2026-09-06）。
 *
 * 原稿エディタで `.md` を開いた状態で「執筆AI支援 → 原稿づくり →
 * **縦書きで開く**」を押すと、必ず
 * 「本文のファイルを開いてから実行してください。」で止まっていた。
 * 作者から見ると「本文を開いているのに開いていないと言われる」。
 *
 * **原因は `vscode.window.activeTextEditor` を直に見ていたこと。**
 * 原稿エディタはWebView（カスタムエディタ）なので `TextEditor` を持たず、
 * ここは undefined になる。タブの種類（`TabInputCustom`）から辿れば
 * 開いている本文の場所が分かる。
 *
 * **同じことが VS Code 1.131 の新しいMarkdown編集画面でも起きた**
 * （hybrid Markdown editor。実機、2026-09-12）。エクスプローラーから
 * `.md` を開くとこの画面になり、やはり `TextEditor` を持たないので
 * 「縦書きで開く」が断られた。viewType は VS Code の都合で変わりうるので
 * 名前で当てにいかず、「本文のファイルをカスタムエディタで開いている」
 * ことだけを見る。
 */

/**
 * タブの代役。**`vi.mock` は先頭へ巻き上げられる**ので、
 * 差し替えに使うものは `vi.hoisted` の中で作る
 */
const stub = vi.hoisted(() => {
  class FakeTabInputCustom {
    constructor(
      readonly uri: { fsPath: string },
      readonly viewType: string
    ) {}
  }
  class FakeTabInputText {
    constructor(readonly uri: { fsPath: string }) {}
  }
  return {
    FakeTabInputCustom,
    FakeTabInputText,
    /** いまアクティブなタブの中身（試験ごとに差し替える） */
    activeTabInput: undefined as unknown,
  };
});

vi.mock("vscode", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    TabInputCustom: stub.FakeTabInputCustom,
    TabInputText: stub.FakeTabInputText,
    window: {
      ...(actual.window as Record<string, unknown>),
      get tabGroups() {
        return {
          activeTabGroup: { activeTab: { input: stub.activeTabInput } },
        };
      },
    },
  };
});

import {
  MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE,
  MANUSCRIPT_EDITOR_VIEW_TYPE,
  activeManuscriptTabUri,
} from "../../src/features/manuscriptEditor";
import { manuscriptNotOpenMessage } from "../../src/features/manuscriptTab";

const manuscript = { fsPath: "C:/小説/いじめられっ子/本文/002.md" };
const plainText = { fsPath: "C:/小説/いじめられっ子/本文/003.txt" };
const settings = { fsPath: "C:/小説/いじめられっ子/設定/人物/002.json" };

/** VS Code 1.131 の新しいMarkdown編集画面。IDは当てにしない */
const HYBRID_VIEW_TYPE = "vscode.markdown.editor";

beforeEach(() => {
  stub.activeTabInput = undefined;
});

describe("原稿エディタで開いている本文", () => {
  test("縦書きで開いていれば、その場所が取れる", () => {
    stub.activeTabInput = new stub.FakeTabInputCustom(
      manuscript,
      MANUSCRIPT_EDITOR_VIEW_TYPE
    );

    expect(activeManuscriptTabUri()).toBe(manuscript);
  });

  test("横書きでも同じ", () => {
    // 既定は横書きなので、こちらを落とすと実質いつも使えない
    stub.activeTabInput = new stub.FakeTabInputCustom(
      manuscript,
      MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE
    );

    expect(activeManuscriptTabUri()).toBe(manuscript);
  });

  test("VS Code のMarkdown編集画面（hybrid）で開いていても、場所が取れる", () => {
    // エクスプローラーから開くとこの画面になる（VS Code 1.131〜）。
    // 開き直すだけの操作に、TextEditor は要らない
    stub.activeTabInput = new stub.FakeTabInputCustom(
      manuscript,
      HYBRID_VIEW_TYPE
    );

    expect(activeManuscriptTabUri()).toBe(manuscript);
  });

  test("原稿エディタでない未知の入口でも、.txt なら引き受ける", () => {
    // viewType の名前では判定しない。見るのは「本文のファイルか」だけ
    stub.activeTabInput = new stub.FakeTabInputCustom(
      plainText,
      "some.other.editor"
    );

    expect(activeManuscriptTabUri()).toBe(plainText);
  });

  test("本文でないファイルのカスタムタブなら、引き受けない", () => {
    // 設定資料のJSONを別のエディタで開いているだけ。本文ではない
    stub.activeTabInput = new stub.FakeTabInputCustom(
      settings,
      "some.other.editor"
    );

    expect(activeManuscriptTabUri()).toBeUndefined();
  });

  test("素のエディタのタブなら、引き受けない", () => {
    // こちらは `activeTextEditor` が答えるので、二重に見ない
    stub.activeTabInput = new stub.FakeTabInputText(manuscript);

    expect(activeManuscriptTabUri()).toBeUndefined();
  });

  test("タブが無くても落ちない", () => {
    stub.activeTabInput = undefined;

    expect(activeManuscriptTabUri()).toBeUndefined();
  });
});

/**
 * **判定は1本にまとめる。** 同じ形のコマンドを足すたびに
 * `activeTextEditor` を直に書くと、原稿エディタで使えないコマンドが
 * また増える。
 */
describe("縦書きで開く", () => {
  const source = readFileSync(
    resolve(__dirname, "../../src/extension.ts"),
    "utf8"
  );

  test("共通の関数を通す", () => {
    const command = source.slice(
      source.indexOf('registerCommand("novelai.openVertical"')
    );
    const body = command.slice(0, command.indexOf("}),"));

    expect(body).toContain("activeManuscriptUri()");
    // 直に見ていると、原稿エディタからは永久に使えない
    expect(body).not.toContain("activeTextEditor");
  });

  test("共通の関数は、原稿エディタのタブも見る", () => {
    const helper = source.slice(
      source.indexOf("function activeManuscriptUri(")
    );
    const body = helper.slice(0, helper.indexOf("\n}"));

    expect(body).toContain("activeTextEditor");
    expect(body).toContain("activeManuscriptTabUri()");
  });

  test("断り文句は共通の関数から出す", () => {
    // 文言の写しが増えると、直した側だけが案内を出すようになる
    expect(source).not.toContain("本文のファイルを開いてから実行してください。");
    expect(source).toContain("warnManuscriptNotOpen()");
  });
});

/**
 * **断る言い方を、状況で分ける**（実機、2026-09-12）。
 *
 * ルビ・傍点は `editor.edit` で本文へ入れるので `TextEditor` が要る。
 * hybridの画面からは当て先が無く断るしかないが、本文を開いている作者に
 * 「本文を開いてから」と言うと、打つ手が無くなる。
 */
describe("本文が見つからないときの文言", () => {
  test("何も開いていなければ、これまでどおり", () => {
    stub.activeTabInput = undefined;

    expect(manuscriptNotOpenMessage()).toBe(
      "本文のファイルを開いてから実行してください。"
    );
  });

  test("hybridの画面なら、次にすることを言う", () => {
    stub.activeTabInput = new stub.FakeTabInputCustom(
      manuscript,
      HYBRID_VIEW_TYPE
    );

    expect(manuscriptNotOpenMessage()).toContain("Markdown 画面");
    expect(manuscriptNotOpenMessage()).toContain("作品一覧から開き直す");
  });

  test("原稿エディタのタブは、この案内の対象ではない", () => {
    // 自前の画面なので「開き直してください」は的外れになる
    stub.activeTabInput = new stub.FakeTabInputCustom(
      manuscript,
      MANUSCRIPT_EDITOR_VIEW_TYPE
    );

    expect(manuscriptNotOpenMessage()).toBe(
      "本文のファイルを開いてから実行してください。"
    );
  });
});
