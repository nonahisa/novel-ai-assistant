import { beforeEach, describe, expect, test, vi } from "vitest";
import * as nodePath from "path";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 「校閲開始／終了」は、原稿エディターで開いた話でも押さえるファイルを
 * 見つける（作者の裁定、2026-10-12）。
 *
 * 押さえるファイルを `vscode.window.activeTextEditor` だけで決めていたため、
 * 原稿エディター（カスタムエディター。既定の開き方）で話を開いていると
 * 空になり、「校閲するファイルを開いてから実行してください」で止まっていた。
 * 前に出ているタブ（`TabInputText` でも `TabInputCustom` でも）から場所を取る。
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
    activeTabInput: undefined as unknown,
    warnings: [] as string[],
  };
});

vi.mock("vscode", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    TabInputCustom: stub.FakeTabInputCustom,
    TabInputText: stub.FakeTabInputText,
    TabInputWebview: stub.FakeTabInputWebview,
    window: {
      ...(actual.window as Record<string, unknown>),
      activeTextEditor: undefined,
      showWarningMessage: async (message: string) => {
        stub.warnings.push(message);
        return undefined;
      },
      get tabGroups() {
        return {
          activeTabGroup: { activeTab: { input: stub.activeTabInput } },
        };
      },
    },
  };
});

import { activeTabFileUri } from "../../../src/features/manuscriptTab";
import { toggleReviewLock } from "../../../src/features/reviewProposals";
import { MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE } from "../../../src/core/manuscriptViewTypes";

const work: WorkEntry = {
  id: "work_test",
  title: "氷の街",
  folderPath: nodePath.join("C:", "novels", "work"),
  registeredAt: "2026-10-12T00:00:00.000Z",
};

/** この作品の外にある話（押さえる手前の「作品のファイルか」で止まる） */
const outside = { fsPath: nodePath.join("C:", "novels", "other", "本文", "001.md") };

beforeEach(() => {
  stub.activeTabInput = undefined;
  stub.warnings = [];
});

describe("前に出ているタブのファイル", () => {
  test("原稿エディター（カスタムエディター）で開いていれば、その場所", () => {
    stub.activeTabInput = new stub.FakeTabInputCustom(
      outside,
      MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE
    );
    expect(activeTabFileUri()).toBe(outside);
  });

  test("素のエディターで開いていれば、その場所", () => {
    stub.activeTabInput = new stub.FakeTabInputText(outside);
    expect(activeTabFileUri()).toBe(outside);
  });

  test("パネル（WebView）が前なら、場所は無い", () => {
    stub.activeTabInput = new stub.FakeTabInputWebview("novelai.proposals");
    expect(activeTabFileUri()).toBeUndefined();
  });

  test("タブが無くても落ちない", () => {
    expect(activeTabFileUri()).toBeUndefined();
  });
});

describe("校閲開始／終了", () => {
  test("原稿エディターで開いた話でも、「開いてから」で止まらない", async () => {
    stub.activeTabInput = new stub.FakeTabInputCustom(
      outside,
      MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE
    );

    await toggleReviewLock(work);

    // 場所が取れたので、次の関門（作品のファイルか）まで進んでいる
    expect(stub.warnings).toEqual(["この作品のファイルではありません。"]);
  });

  test("ファイルを指すタブが無ければ、今までどおりの文で止まる", async () => {
    stub.activeTabInput = new stub.FakeTabInputWebview("novelai.proposals");

    await toggleReviewLock(work);

    expect(stub.warnings).toEqual([
      "校閲するファイルを開いてから実行してください。",
    ]);
  });
});
