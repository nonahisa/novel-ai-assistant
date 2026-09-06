import { describe, expect, test, vi, beforeEach } from "vitest";

/**
 * 開いているタブ全部から本文を探す（実機、2026-09-06）。
 *
 * 設定資料パネルの「ルビを追加」は WebView の中のボタンなので、押した時点で
 * アクティブなタブは必ずそのパネルである。「いまアクティブなタブ」しか見ない
 * `activeManuscriptTabUri` では、原稿エディタで本文を開いていても
 * 「いま開いている話」が一度も出なかった。
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
  class FakeTabInputWebview {
    constructor(readonly viewType: string) {}
  }
  return {
    FakeTabInputCustom,
    FakeTabInputText,
    FakeTabInputWebview,
    /** 全グループのタブ（試験ごとに差し替える） */
    groups: [] as Array<{ tabs: Array<{ input: unknown; isActive: boolean }> }>,
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
        return { all: stub.groups };
      },
    },
  };
});

import {
  MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE,
  MANUSCRIPT_EDITOR_VIEW_TYPE,
  openManuscriptTabUris,
} from "../../src/features/manuscriptEditor";

const second = { fsPath: "C:/小説/いじめられっ子/episode_0002.md" };
const sixth = { fsPath: "C:/小説/いじめられっ子/episode_0006.md" };

beforeEach(() => {
  stub.groups = [];
});

describe("開いているタブ全部から本文を探す", () => {
  test("設定資料パネルがアクティブでも、隣のグループの原稿エディタを拾う", () => {
    stub.groups = [
      {
        tabs: [
          { input: new stub.FakeTabInputWebview("novelai.settings"), isActive: true },
        ],
      },
      {
        tabs: [
          {
            input: new stub.FakeTabInputCustom(sixth, MANUSCRIPT_EDITOR_VIEW_TYPE),
            isActive: true,
          },
        ],
      },
    ];

    expect(openManuscriptTabUris()).toEqual([sixth]);
  });

  test("同じグループの、アクティブでない原稿エディタも拾う", () => {
    // パネルとエディタが同じグループにあると、エディタのタブは裏に回る
    stub.groups = [
      {
        tabs: [
          { input: new stub.FakeTabInputWebview("novelai.settings"), isActive: true },
          {
            input: new stub.FakeTabInputCustom(
              sixth,
              MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE
            ),
            isActive: false,
          },
        ],
      },
    ];

    expect(openManuscriptTabUris()).toEqual([sixth]);
  });

  test("各グループでアクティブなタブを先に並べる", () => {
    stub.groups = [
      {
        tabs: [
          { input: new stub.FakeTabInputText(second), isActive: false },
          {
            input: new stub.FakeTabInputCustom(sixth, MANUSCRIPT_EDITOR_VIEW_TYPE),
            isActive: true,
          },
        ],
      },
    ];

    expect(openManuscriptTabUris()).toEqual([sixth, second]);
  });

  test("別のカスタムエディタは拾わない", () => {
    stub.groups = [
      {
        tabs: [
          {
            input: new stub.FakeTabInputCustom(sixth, "some.other.editor"),
            isActive: true,
          },
        ],
      },
    ];

    expect(openManuscriptTabUris()).toEqual([]);
  });

  test("タブが無くても落ちない", () => {
    expect(openManuscriptTabUris()).toEqual([]);
  });
});
