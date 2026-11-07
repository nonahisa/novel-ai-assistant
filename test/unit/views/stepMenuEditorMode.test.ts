import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { WorkEntry } from "../../../src/models/types";
import type { WorkRegistry } from "../../../src/core/workRegistry";
import type { EditorProgressFacts } from "../../../src/core/editorProgress";

/**
 * 編集者メニュー（作者の指示 2026-11-05 夜「編集者用のメニューは専用のものを表示するようにして、
 * 上から順番に処理したら終わるようにしたほうがよさそうです」。設計書5.6.6）。
 *
 * - 編集者モードでは簡単ステップメニューに何も並べず、横の枠の一番上の編集者メニューが手順を持つ
 *   （作者モードの並びは何も変えない）
 * - 編集者メニューは、作品（切り替え）・この作品の編集を終える・作品を足す・状態の行・手順1〜7・
 *   ヘルプ・作者モードへ戻る の順
 * - 手順に並べる操作は、編集者モードで押せる操作だけ
 */

let mode: "author" | "editor" = "author";
vi.mock("../../../src/core/actorContext", () => ({
  currentMode: () => mode,
  isEditorMode: () => mode === "editor",
}));

const { STEP_MENU, StepMenuProvider, restoreExpandedSteps } = await import(
  "../../../src/views/stepMenu"
);
const {
  EditorMenuProvider,
  EDITOR_END_WORK_COMMAND,
  EDITOR_JOIN_COMMAND,
  EDITOR_SELECT_HINT,
  EDITOR_WORK_COMMAND,
  resolveEditorEntry,
} = await import("../../../src/views/editorMenu");
const { EDITOR_STEP_DEFS, EDITOR_STEP_REFERENCED_COMMANDS } = await import(
  "../../../src/core/stepDefs"
);
const { isCommandAllowed } = await import("../../../src/core/editorMode");

function work(id: string, title: string): WorkEntry {
  return {
    id,
    title,
    folderPath: `C:/works/${id}`,
    registeredAt: "2026-11-01T00:00:00.000Z",
  };
}

function registryOf(works: WorkEntry[]): WorkRegistry {
  return {
    list: () => works,
    onDidChange: () => ({ dispose() {} }),
  } as unknown as WorkRegistry;
}

function stepProvider(works: WorkEntry[]) {
  return new StepMenuProvider(
    registryOf(works),
    undefined,
    undefined,
    undefined,
    async () => undefined,
    async () => undefined
  );
}

const cleanFacts: EditorProgressFacts = {
  sync: { behind: 0, ahead: 0, dirty: 0 },
  myLocks: [],
  myProposals: [],
  seenDecisions: new Set(),
};

function editorMenu(works: WorkEntry[], selected?: string, facts: EditorProgressFacts = cleanFacts) {
  let saved = selected;
  return new EditorMenuProvider(
    registryOf(works),
    { get: () => saved, set: (id) => (saved = id) },
    async () => ({ facts })
  );
}

function labelOf(item: { label?: unknown }): string {
  const label = item.label;
  if (typeof label === "string") return label;
  if (label && typeof label === "object" && "label" in label) return String((label as { label: unknown }).label);
  return "";
}

beforeEach(() => {
  mode = "author";
});

describe("簡単ステップメニューは、作者モードの並びを変えない", () => {
  test("作者モードは今までどおりの並び（作品づくりの7段とヘルプ）", () => {
    const menu = stepProvider([work("a", "氷の街")]);
    expect(menu.visibleSteps().map((step) => step.label)).toEqual([
      "1. 作品登録",
      "2. 新作構想",
      "3. 作品執筆",
      "4. 自己校正",
      "5. 投稿脱稿",
      "6. 編集者校正・校閲",
      "7. 電子出版等",
      "ヘルプ",
    ]);
    expect(menu.visibleSteps().map((step) => step.label)).toEqual(STEP_MENU.map((step) => step.label));
  });

  test("編集者モードでは何も並べない（手順は一番上の編集者メニューにある）", () => {
    mode = "editor";
    expect(stepProvider([work("a", "氷の街")]).visibleSteps()).toEqual([]);
    mode = "author";
    expect(stepProvider([work("a", "氷の街")]).visibleSteps()[0].label).toBe("1. 作品登録");
  });

  test("開閉の覚えは、作者の段の名前だけを残す", () => {
    const restored = restoreExpandedSteps(["3. 機械に探させる", "1. 作品登録", "消えた段"]);
    expect([...restored]).toEqual(["1. 作品登録"]);
  });
});

describe("編集者メニューの手順の定義", () => {
  test("手順は上から順に7つ", () => {
    expect(EDITOR_STEP_DEFS.map((def) => def.label)).toEqual([
      "1. 作者の最新の原稿を受け取る",
      "2. 校閲する話を選ぶ",
      "3. 機械に探させる",
      "4. 直しを提案する・メモ（意見）を書く",
      "5. 置いた提案を見直す",
      "6. 校閲を終えて作者へ返す",
      "7. 作者の採否を見る",
    ]);
  });

  test("並べる操作は、詳細メニューに実在するか、ここで名前と説明を持つ", () => {
    for (const def of EDITOR_STEP_DEFS) {
      for (const entry of def.entries) {
        expect(resolveEditorEntry(entry), JSON.stringify(entry)).toBeDefined();
      }
    }
  });

  test("並べる操作は、package.json に実在し、編集者モードで押せる", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      contributes: { commands: Array<{ command: string }> };
    };
    const known = new Set(pkg.contributes.commands.map((entry) => entry.command));
    for (const command of [
      ...EDITOR_STEP_REFERENCED_COMMANDS,
      EDITOR_WORK_COMMAND,
      EDITOR_END_WORK_COMMAND,
      EDITOR_JOIN_COMMAND,
    ]) {
      expect(known.has(command), `${command} が package.json に無い`).toBe(true);
      expect(isCommandAllowed(command, "editor"), `${command} が編集者モードで押せない`).toBe(true);
    }
  });

  test("受け取りは「保存・同期」（編集者は受け取るだけ）、4は修正とメモの両方を並べる", () => {
    const byKey = new Map(EDITOR_STEP_DEFS.map((def) => [def.key, def]));
    expect(byKey.get("receive")?.entries).toEqual(["novelai.saveAndSync"]);
    const propose = (byKey.get("propose")?.entries ?? []).map((entry) =>
      typeof entry === "string" ? entry : entry.command
    );
    expect(propose).toEqual(["novelai.proposeEditByHand", "novelai.addSceneMemo"]);
    const detect = (byKey.get("detect")?.entries ?? []).map((entry) =>
      typeof entry === "string" ? entry : entry.command
    );
    // AI を使わない表記ゆれ検知から並べ、説明にそう書く
    expect(detect[0]).toBe("novelai.checkNotation");
    expect(byKey.get("detect")?.detail).toContain("AI");
  });

  test("説明の1行目は40字以内で、強調の印と内輪の呼び名を置かない", () => {
    for (const def of EDITOR_STEP_DEFS) {
      const head = def.detail.split("\n")[0];
      expect(head.length, def.label).toBeLessThanOrEqual(40);
      expect(def.detail.includes("*".repeat(2)), def.label).toBe(false);
      expect(def.detail.includes("母艦"), def.label).toBe(false);
    }
  });
});

describe("編集者メニューの並び", () => {
  test("作品・編集を終える・作品を足す・状態の行・手順1〜7・ヘルプ・作者モードへ戻る", async () => {
    mode = "editor";
    const menu = editorMenu([work("a", "氷の街")]);
    const nodes = await menu.getChildren();
    const labels = nodes.map((node) => labelOf(menu.getTreeItem(node)));
    expect(labels[0]).toBe("作品：氷の街");
    expect(labels[1]).toBe("この作品の編集を終える");
    expect(labels[2]).toBe("作品を足す（参加のリンクを貼る）");
    expect(labels.slice(3, 7).map((label) => label.split("：")[0])).toEqual([
      "校閲中の話",
      "置いた提案",
      "作者の採否",
      "受け取り",
    ]);
    expect(labels.slice(7, 14)).toEqual(EDITOR_STEP_DEFS.map((def) => def.label));
    expect(labels.slice(14)).toEqual(["ヘルプ", "作者モードへ戻る"]);
  });

  test("作品がまだ無いときは「参加のリンクを貼る」だけを一番上に出し、手順は押せない", async () => {
    mode = "editor";
    const menu = editorMenu([]);
    const nodes = await menu.getChildren();
    const first = menu.getTreeItem(nodes[0]);
    expect(labelOf(first)).toBe("参加のリンクを貼る");
    expect(first.command?.command).toBe(EDITOR_JOIN_COMMAND);
    const labels = nodes.map((node) => labelOf(menu.getTreeItem(node)));
    expect(labels).not.toContain("この作品の編集を終える");
    expect(labels.some((label) => label.startsWith("作品："))).toBe(false);
    const range = nodes.find((node) => node.type === "step" && node.def.key === "range");
    expect(range && menu.getTreeItem(range).command).toBeUndefined();
  });

  test("作品の行を押すと、作品を選び直せる（作品が1つでも、足す口があるので押せる）", async () => {
    mode = "editor";
    const menu = editorMenu([work("a", "氷の街")]);
    const item = menu.getTreeItem({ type: "work" });
    expect(item.command?.command).toBe(EDITOR_WORK_COMMAND);
  });

  test("作品が2つ以上で選んでいないときは、手順は押せず「一番上で作品を選ぶ」と言う", async () => {
    mode = "editor";
    const menu = editorMenu([work("a", "氷の街"), work("b", "砂の塔")]);
    const nodes = await menu.getChildren();
    expect(labelOf(menu.getTreeItem(nodes[0]))).toBe("作品を選ぶ");
    const range = nodes.find((node) => node.type === "step" && node.def.key === "range");
    if (!range) throw new Error("手順2が無い");
    const item = menu.getTreeItem(range);
    expect(item.command).toBeUndefined();
    expect(String(item.description)).toContain(EDITOR_SELECT_HINT);
  });

  test("選んだ作品を「この作品の編集を終える」へ渡す（登録の解除）", async () => {
    mode = "editor";
    const menu = editorMenu([work("a", "氷の街"), work("b", "砂の塔")], "b");
    const item = menu.getTreeItem({ type: "endWork" });
    expect(item.command?.command).toBe(EDITOR_END_WORK_COMMAND);
    expect(item.command?.arguments?.[0]).toMatchObject({ type: "work", work: { id: "b" } });
  });

  test("手順の行の説明に印が出る（済み・次はここ・まだ）", async () => {
    mode = "editor";
    const menu = editorMenu([work("a", "氷の街")]);
    const nodes = await menu.getChildren();
    const descriptionOf = (key: string): string => {
      const node = nodes.find((entry) => entry.type === "step" && entry.def.key === key);
      return node ? String(menu.getTreeItem(node).description) : "";
    };
    expect(descriptionOf("receive")).toContain("済み");
    expect(descriptionOf("range")).toContain("次はここ");
    expect(descriptionOf("detect")).toContain("まだ");
  });

  test("押すだけの手順は、行そのものが選んだ作品で命令を走らせる", async () => {
    mode = "editor";
    const menu = editorMenu([work("a", "氷の街")]);
    const nodes = await menu.getChildren();
    const range = nodes.find((node) => node.type === "step" && node.def.key === "range");
    if (!range) throw new Error("手順2が無い");
    const item = menu.getTreeItem(range);
    expect(item.command?.command).toBe("novelai.toggleReviewLock");
    expect(item.command?.arguments?.[0]).toMatchObject({ type: "work", work: { id: "a" } });
  });

  test("いくつか並ぶ手順は、開くと操作が並ぶ", async () => {
    mode = "editor";
    const menu = editorMenu([work("a", "氷の街")]);
    const nodes = await menu.getChildren();
    const propose = nodes.find((node) => node.type === "step" && node.def.key === "propose");
    if (!propose) throw new Error("手順4が無い");
    const children = await menu.getChildren(propose);
    expect(children.map((node) => labelOf(menu.getTreeItem(node)))).toEqual([
      "修正を提案する",
      "ここにメモ（意見）を足す",
    ]);
  });
});

describe("モードを切り替えた瞬間に描き直す", () => {
  test("設定 novelai.mode の変化を見て、簡単ステップメニューと編集者メニューを描き直す", () => {
    const source = readFileSync("src/extension.ts", "utf8");
    const at = source.indexOf('affectsConfiguration("novelai.mode")');
    expect(at, "novelai.mode の変化を見ていない").toBeGreaterThan(-1);
    const body = source.slice(at, at + 900);
    expect(body).toContain("stepProvider.refresh()");
    expect(body).toContain("editorMenuProvider.refresh()");
  });

  test("編集者メニューは編集者モードでだけ出て、簡単ステップメニューは編集者モードで出ない", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      contributes: { views: Record<string, Array<{ id: string; when?: string }>> };
    };
    const views = pkg.contributes.views["novelai"];
    // 一番上（配列の先頭）に置く
    expect(views[0].id).toBe("novelai.editorMenu");
    expect(views[0].when).toContain("novelai.editorMode");
    expect(views.find((view) => view.id === "novelai.steps")?.when).toContain(
      "!novelai.editorMode"
    );
  });
});
