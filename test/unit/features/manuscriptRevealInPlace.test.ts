import { beforeEach, describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 開いている原稿の面を前に出すときは、**その面が居る列を渡す**（設計書6.25.11）。
 *
 * 作者の実機（2026-10-03、3回目）：校正・メモパネル（右の列）の行を押すと、
 * 右の列に同じ話のタブ（斜体）ができて、左の原稿が真っ白になった。
 *
 * VS Code の束（1.90・1.138・1.140）で確かめた仕組み：
 * - `WebviewPanel.reveal()` を列なしで呼ぶと、VS Code は「いま前面の列」へ開く
 * - 既に開いている列を探し直すのは、入力が「1つしか開けないもの」（Singleton）の
 *   ときだけ。**テキスト型のカスタムエディターは、拡張機能が
 *   `supportsMultipleEditorsPerDocument: false` を渡しても VS Code が true に
 *   決め打ちする**ので、Singleton にならない
 * - 結果、同じ入力が前面の列（パネルのある右）でも開かれ、画面の実体がそちらへ
 *   移って、左のタブは中身の抜けた空白で残る
 *
 * 素の WebviewPanel（相関図・年表など）は Singleton なので、列なしでも元の列へ戻る。
 */

const layout = vi.hoisted(() => {
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
    TabInputCustom,
    groups: undefined as
      | Array<{
          viewColumn: number;
          isActive: boolean;
          tabs: Array<{ input: unknown; isActive?: boolean }>;
        }>
      | undefined,
  };
});

vi.mock("vscode", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    TabInputCustom: layout.TabInputCustom,
    window: {
      ...(actual.window as Record<string, unknown>),
      get tabGroups() {
        if (!layout.groups) throw new Error("タブを読めない環境");
        return {
          all: layout.groups,
          activeTabGroup: layout.groups.find((group) => group.isActive),
        };
      },
    },
  };
});

import {
  manuscriptLedgerKey,
  revealManuscriptPanelInPlace,
} from "../../../src/features/manuscriptTab";
import { MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE } from "../../../src/core/manuscriptViewTypes";

const episodePath = "C:/小説/いじめられっ子/本文/001.md";

function fakePanel(viewColumn: number | undefined) {
  const calls: unknown[][] = [];
  return {
    calls,
    panel: {
      viewColumn,
      reveal: (...args: unknown[]) => {
        calls.push(args);
      },
    },
  };
}

beforeEach(() => {
  layout.groups = undefined;
});

describe("開いている原稿の面を、その列のまま前に出す", () => {
  test("面の列が分かれば、その列を渡して前に出す（焦点は移す）", () => {
    const { calls, panel } = fakePanel(1);

    revealManuscriptPanelInPlace(panel, manuscriptLedgerKey(episodePath));

    expect(calls).toEqual([[1, false]]);
  });

  test("面の列が読めなければ、タブの居る列を渡す", () => {
    layout.groups = [
      {
        viewColumn: 1,
        isActive: false,
        tabs: [
          {
            input: new layout.TabInputCustom(
              episodePath,
              MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE
            ),
            isActive: true,
          },
        ],
      },
      // パネルのある右の列が前面
      { viewColumn: 2, isActive: true, tabs: [{ input: {}, isActive: true }] },
    ];
    const { calls, panel } = fakePanel(undefined);

    revealManuscriptPanelInPlace(panel, manuscriptLedgerKey(episodePath));

    expect(calls).toEqual([[1, false]]);
  });
});

/**
 * 直す前は3か所（付箋を挿す・読み上げ・行へ飛ぶ）が `open.panel.reveal()` を
 * 列なしで呼んでいた。**新しく足した道が同じ穴を開けないよう、源で見張る。**
 */
describe("原稿エディターの源", () => {
  test("面を列なしで前に出していない", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../../../src/features/manuscriptEditor.ts"),
      "utf8"
    );
    const offenders = source
      .split(/\r?\n/)
      .map((line, index) => ({ line: line.trim(), no: index + 1 }))
      .filter(({ line }) => /panel\.reveal\(\s*\)/.test(line))
      .filter(({ line }) => !line.startsWith("*") && !line.startsWith("//"));

    expect(offenders).toEqual([]);
  });
});
