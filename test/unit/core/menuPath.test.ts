import { describe, expect, test } from "vitest";
import {
  ACTION_TREE,
  isItemVisibleInRuntime,
  type ActionItem,
} from "../../../src/core/actionTree";
import {
  MENU_PATH_START,
  MENU_PATH_TARGET_MARK,
  guideMenuEntries,
  menuPathLine,
  menuPathTree,
  menuPathsOf,
  renderMenuPathText,
  shortMenuPath,
} from "../../../src/core/menuPath";
import {
  EDITOR_STEP_DEFS,
  EDITOR_STEP_REFERENCED_COMMANDS,
} from "../../../src/core/stepDefs";
import type { WorkMode } from "../../../src/core/editorMode";

/**
 * 使い方の答えに添える「メニューの場所の図」（設計書6.118）。
 *
 * **元になる定義（`ACTION_TREE`）を直接歩いて**確かめる。図を組む関数が自分で歩いた結果と
 * 比べても、両方が同時にずれれば気づけない。
 */

/** 木の中の操作を全部（小分類の中も） */
function treeActions(): ActionItem[] {
  return ACTION_TREE.flatMap((group) =>
    group.entries.flatMap((entry) => (entry.kind === "section" ? entry.items : [entry]))
  );
}

const MODES: readonly WorkMode[] = ["author", "editor"];

describe("どの操作にも、画面のどこかに行ける道がある", () => {
  for (const runtime of [true, false]) {
    for (const mode of MODES) {
      test(`${runtime ? "手元" : "ブラウザ版"}・${mode === "author" ? "作者" : "編集者"}モード`, () => {
        // 旧入口（`supersededBy`）は目次にも載せない操作なので除く
        const missing = treeActions()
          .filter((item) => isItemVisibleInRuntime(item, runtime) && !item.supersededBy)
          .filter((item) => menuPathsOf(item.command, mode, runtime).length === 0)
          .map((item) => `${item.label}（${item.command}）`);
        expect(missing).toEqual([]);
      });
    }
  }

  test("編集者メニューが参照する操作は、編集者モードでは編集者メニューの道を持つ", () => {
    const missing = EDITOR_STEP_REFERENCED_COMMANDS.filter(
      (command) =>
        !menuPathsOf(command, "editor", true).some((path) => path.place === "editorMenu")
    );
    expect(missing).toEqual([]);
  });

  test("作者モードでは編集者メニューを通らない（ビューが出ていない）", () => {
    for (const command of EDITOR_STEP_REFERENCED_COMMANDS) {
      expect(
        menuPathsOf(command, "author", true).some((path) => path.place === "editorMenu"),
        command
      ).toBe(false);
    }
  });

  test("編集者モードでは簡単ステップメニューを通らない（ビューが出ていない）", () => {
    for (const item of treeActions()) {
      expect(
        menuPathsOf(item.command, "editor", true).some((path) => path.place === "steps"),
        item.command
      ).toBe(false);
    }
  });
});

describe("図の形", () => {
  test("1行の道順は、最初の一押し（左の端のアイコン）から始まる", () => {
    for (const mode of MODES) {
      for (const item of treeActions()) {
        for (const path of menuPathsOf(item.command, mode, true)) {
          if (path.place === "entrance") continue;
          expect(menuPathLine(path).startsWith(`${MENU_PATH_START} → `), item.command).toBe(true);
        }
      }
    }
  });

  test("木の先頭も最初の一押しで、目標の行にだけ印が付く", () => {
    for (const mode of MODES) {
      for (const item of treeActions()) {
        for (const path of menuPathsOf(item.command, mode, true)) {
          if (path.place === "entrance") continue;
          const lines = menuPathTree(path).split("\n");
          expect(lines[0]).toBe(MENU_PATH_START);
          const marked = lines.filter((line) => line.includes(MENU_PATH_TARGET_MARK));
          expect(marked, `${item.command} ${path.trail.join("/")}`).toHaveLength(1);
          expect(marked[0]).toContain(path.trail[path.trail.length - 1]);
        }
      }
    }
  });

  test("作者モードの「編集者の提案を見る」は、簡単ステップメニューが先で、詳細メニューも添える", () => {
    const text = renderMenuPathText("novelai.viewEditorProposals", "author", true);
    const lines = text.split("\n");
    expect(lines[0]).toBe(
      `${MENU_PATH_START} → 簡単ステップメニュー → 6. 編集者校正・校閲 → 編集者の提案を見る`
    );
    expect(text).toContain(`${MENU_PATH_TARGET_MARK} 編集者の提案を見る（ここ）`);
    // 兄弟も並ぶ（どこにあるかを周りの行で確かめられる）
    expect(text).toContain("・ 編集者へ渡す");
    expect(text).toContain(
      `ほかの道：${MENU_PATH_START} → 詳細メニュー → 作品管理 → 編集者連携 → 編集者の提案を見る`
    );
  });

  test("編集者モードの「置いた提案の一覧」は、編集者メニューの5の中", () => {
    const text = renderMenuPathText("novelai.listPlacedProposals", "editor", true);
    expect(text.split("\n")[0]).toBe(
      `${MENU_PATH_START} → 編集者メニュー → 5. 置いた提案を見直す → 置いた提案の一覧`
    );
  });

  test("押すとそのまま走る手順は、手順の行そのものを指す", () => {
    const text = renderMenuPathText("novelai.finishReviewAndReturn", "editor", true);
    expect(text.split("\n")[0]).toBe(
      `${MENU_PATH_START} → 編集者メニュー → 6. 校閲を終えて作者へ返す`
    );
    // 一番上の階層の兄弟（7つの手順）が並ぶ
    for (const def of EDITOR_STEP_DEFS) expect(text).toContain(def.label);
  });

  test("編集者モードで、作者だけの操作はモードの切り替えを添えた入口になる", () => {
    const paths = menuPathsOf("novelai.viewEditorProposals", "editor", true);
    expect(paths).toHaveLength(1);
    expect(paths[0].place).toBe("entrance");
    expect(menuPathLine(paths[0])).toContain("作者モードの詳細メニュー");
  });

  test("編集者モードで押せない操作には、その旨を添える", () => {
    expect(renderMenuPathText("novelai.extractSettings", "editor", true)).toContain(
      "編集者モードでは押せません"
    );
    expect(renderMenuPathText("novelai.extractSettings", "author", true)).not.toContain(
      "編集者モードでは押せません"
    );
  });

  test("メニューの外の入口は、案内の1行だけ（同じ行を重ねない）", () => {
    const text = renderMenuPathText("novelai.addRuby", "author", true);
    expect(text.startsWith("入口：")).toBe(true);
    expect(text.split("\n")).toHaveLength(1);
  });

  test("知らない操作は空文字（それらしい道を作らない）", () => {
    expect(renderMenuPathText("novelai.存在しない操作", "author", true)).toBe("");
    expect(shortMenuPath("novelai.存在しない操作", "author", true)).toBeUndefined();
  });

  test("手順書き用の短い場所は、区画から親まで", () => {
    expect(shortMenuPath("novelai.shareWithEditor", "author", true)).toBe(
      "簡単ステップメニュー → 6. 編集者校正・校閲"
    );
    expect(shortMenuPath("novelai.listPlacedProposals", "editor", true)).toBe(
      "編集者メニュー → 5. 置いた提案を見直す"
    );
  });
});

describe("名指しの照合先", () => {
  test("編集者モードだけ、編集者メニューにしか無い項目と手順の行が入る", () => {
    const editor = guideMenuEntries("editor");
    const author = guideMenuEntries("author");
    const has = (entries: typeof editor, label: string) =>
      entries.some((entry) => entry.label === label);
    expect(has(editor, "置いた提案の一覧")).toBe(true);
    expect(has(editor, "6. 校閲を終えて作者へ返す")).toBe(true);
    expect(has(author, "置いた提案の一覧")).toBe(false);
    expect(has(author, "6. 校閲を終えて作者へ返す")).toBe(false);
  });
});
