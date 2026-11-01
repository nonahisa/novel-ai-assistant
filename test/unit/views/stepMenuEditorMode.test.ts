import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { WorkEntry } from "../../../src/models/types";
import type { WorkRegistry } from "../../../src/core/workRegistry";

/**
 * 編集者モードの簡単ステップメニュー（作者の指示 2026-11-01「簡単ステップメニュー、
 * 編集モードに切り替えた場合は特化したものに切り替えてください」。設計書6.70・5.6）。
 *
 * 編集部の人は、作品づくりの7段（作品登録・新作構想…）を通らない。押しても
 * 「編集者モードでは使えません」になる段を並べると、何から押せばよいか分からない。
 *
 * - モードで並びが替わること（作者モードの並びは何も変えない）
 * - 編集者モードの段は、編集者モードで押せる操作だけで組まれていること
 * - 最上段は作品の名前を出すだけ（編集者モードの作品は1つまで）
 */

let mode: "author" | "editor" = "author";
vi.mock("../../../src/core/actorContext", () => ({
  currentMode: () => mode,
  isEditorMode: () => mode === "editor",
}));

const {
  EDITOR_STEP_MENU,
  EDITOR_STEP_MENU_MISSING_COMMANDS,
  EDITOR_STEP_REFERENCED_COMMANDS,
  STEP_MENU,
  STEP_WORK_COMMAND,
  StepMenuProvider,
  restoreExpandedSteps,
} = await import("../../../src/views/stepMenu");
const { isCommandAllowed } = await import("../../../src/core/editorMode");

function work(id: string, title: string): WorkEntry {
  return {
    id,
    title,
    folderPath: `C:/works/${id}`,
    registeredAt: "2026-11-01T00:00:00.000Z",
  };
}

function provider(works: WorkEntry[]) {
  const registry = {
    list: () => works,
    onDidChange: () => ({ dispose() {} }),
  } as unknown as WorkRegistry;
  return new StepMenuProvider(
    registry,
    undefined,
    undefined,
    undefined,
    async () => undefined,
    async () => undefined
  );
}

beforeEach(() => {
  mode = "author";
});

describe("モードで、簡単ステップメニューの並びが替わる", () => {
  test("作者モードは今までどおりの並び（作品づくりの7段とヘルプ）", async () => {
    const menu = provider([work("a", "氷の街")]);
    expect(menu.visibleSteps().map((step) => step.label)).toEqual([
      "1. 作品登録",
      "2. 新作構想",
      "3. 作品執筆",
      "4. 自己校正",
      "5. 投稿脱稿",
      "6. 編集部校正・校閲",
      "7. 電子出版等",
      "ヘルプ",
    ]);
    expect(menu.visibleSteps().map((step) => step.label)).toEqual(
      STEP_MENU.map((step) => step.label)
    );
  });

  test("編集者モードは、編集部の流れの段だけになる（作品づくりの段は出さない）", async () => {
    mode = "editor";
    const menu = provider([work("a", "氷の街")]);
    const labels = menu.visibleSteps().map((step) => step.label);
    expect(labels).toEqual(EDITOR_STEP_MENU.map((step) => step.label));
    expect(labels).not.toContain("1. 作品登録");
    expect(labels).not.toContain("2. 新作構想");
    // 流れの順：参加 → 範囲を押さえる → 検知 → 提案を置く → 見る → 返す → 戻る
    expect(labels).toEqual([
      "1. 編集部として参加",
      "2. 校閲する範囲を押さえる",
      "3. 検知で探す",
      "4. 直しを提案する",
      "5. 置いた提案を見る",
      "6. 校閲を終えて返す",
      "7. 作者モードへ戻る",
      "ヘルプ",
    ]);
  });

  test("作者モードへ戻すと、作者の並びへ戻る（作り直さずに、次の描画から）", async () => {
    const menu = provider([work("a", "氷の街")]);
    mode = "editor";
    expect(menu.visibleSteps()[0].label).toBe("1. 編集部として参加");
    mode = "author";
    expect(menu.visibleSteps()[0].label).toBe("1. 作品登録");
  });

  test("編集者モードの段の操作は、すべて詳細メニューに実在する", () => {
    expect(EDITOR_STEP_MENU_MISSING_COMMANDS).toEqual([]);
    expect(EDITOR_STEP_REFERENCED_COMMANDS.length).toBeGreaterThan(0);
  });

  test("編集者モードの段には、編集者モードで押せる操作だけを並べる", () => {
    const blocked = EDITOR_STEP_REFERENCED_COMMANDS.filter(
      (command) => !isCommandAllowed(command, "editor")
    );
    expect(blocked, "editorMode.ts の許可の一覧と食い違っている").toEqual([]);
  });

  test("検知の段は、AI を使わない表記ゆれ検知から並べ、そのことを説明に書く", () => {
    const step = EDITOR_STEP_MENU.find((entry) => entry.label === "3. 検知で探す");
    expect(step).toBeDefined();
    if (!step) return;
    const commands = step.entries.flatMap((entry) =>
      entry.kind === "action" ? [entry.command] : []
    );
    expect(commands[0]).toBe("novelai.checkNotation");
    expect(commands).toContain("novelai.checkTypos");
    expect(commands).toContain("novelai.checkProofread");
    expect(step.detail).toContain("AI");
  });

  test("提案の段は、右クリックからも出せることを説明に添える", () => {
    const step = EDITOR_STEP_MENU.find((entry) => entry.label === "4. 直しを提案する");
    expect(step?.detail).toContain("右クリック");
    expect(step?.detail).toContain("ここにメモを足す");
  });

  test("説明の1行目は40字以内で、強調の印と内輪の呼び名を置かない", () => {
    for (const step of EDITOR_STEP_MENU) {
      const head = step.detail.split("\n")[0];
      expect(head.length, step.label).toBeLessThanOrEqual(40);
      expect(step.detail.includes("*".repeat(2)), step.label).toBe(false);
      expect(step.detail.includes("母艦"), step.label).toBe(false);
    }
  });

  test("開閉の覚えは、編集者モードの段の名前も残す", () => {
    const restored = restoreExpandedSteps(["3. 検知で探す", "1. 作品登録", "消えた段"]);
    expect([...restored].sort()).toEqual(["1. 作品登録", "3. 検知で探す"].sort());
  });
});

describe("編集者モードの最上段", () => {
  test("作品の名前を出すだけで、選び直す口は付けない", () => {
    mode = "editor";
    const menu = provider([work("a", "氷の街")]);
    const item = menu.getTreeItem({ type: "selector" });
    expect(String(item.label)).toContain("氷の街");
    expect(item.command).toBeUndefined();
  });

  test("作者モードでは、今までどおり押して選び直せる", () => {
    const menu = provider([work("a", "氷の街")]);
    const item = menu.getTreeItem({ type: "selector" });
    expect(item.command?.command).toBe(STEP_WORK_COMMAND);
  });
});

describe("モードを切り替えた瞬間に描き直す", () => {
  test("設定 novelai.mode の変化を見て、簡単ステップメニューを描き直す", () => {
    const source = readFileSync("src/extension.ts", "utf8");
    const at = source.indexOf('affectsConfiguration("novelai.mode")');
    expect(at, "novelai.mode の変化を見ていない").toBeGreaterThan(-1);
    expect(source.slice(at, at + 600)).toContain("stepProvider.refresh()");
  });
});
