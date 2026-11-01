import { describe, expect, test } from "vitest";
import { ACTION_TREE, findAction } from "../../../src/core/actionTree";
import { EDITOR_STEP_DEFS } from "../../../src/core/stepDefs";
import { isCommandAllowed } from "../../../src/core/editorMode";
import { canSaveAndSync } from "../../../src/core/gitSyncStatusText";
import {
  describeSyncConfirm,
  describeSyncSkips,
  planSyncTarget,
  type SyncTargetState,
} from "../../../src/core/syncAllPlan";
import {
  describeProcessesBlocked,
  isCommandAvailableInRuntime,
} from "../../../src/core/processAvailability";
import {
  conflictFixHint,
  saveAndSyncLabel,
} from "../../../src/core/syncEntryNames";
import type { GitSyncStatus } from "../../../src/core/git";
import type { WorkEntry } from "../../../src/models/types";

/*
  同期の入口を「保存・同期」1つにまとめる（作者の判断 2026-11-01）。

  以前は詳細メニュー「GitHub作品管理」に「保存・同期」「全作品同期」「同期」「分岐合流」
  「競合解決」が並び、「同期」の中にまた「保存してそろえる」があった（中身は同じ処理）。
  **押すと今の状態を見て、要る段だけを進める入口を1つにする。** 分岐・競合は、
  その場でボタンから開く（メニューには出さない）。

  編集者モードでは「保存・同期」は受け取るだけ。送るのは「校閲を終えて返す」だけ。
*/

const SYNC_COMMANDS = [
  "novelai.saveAndSync",
  "novelai.syncAllWorks",
  "novelai.gitSync",
  "novelai.resolveDivergence",
  "novelai.resolveConflicts",
  "novelai.gitPull",
  "novelai.gitPush",
];

function githubSection() {
  for (const group of ACTION_TREE) {
    for (const entry of group.entries) {
      if (entry.kind === "section" && entry.label === "GitHub作品管理") return entry;
    }
  }
  throw new Error("「GitHub作品管理」の節が見つからない");
}

function tracked(over: Partial<Extract<GitSyncStatus, { kind: "tracked" }>> = {}): GitSyncStatus {
  const behind = over.behind ?? 0;
  const ahead = over.ahead ?? 0;
  const dirty = over.dirty ?? 0;
  return {
    kind: "tracked",
    root: "C:/写し",
    branch: "main",
    upstream: "origin/main",
    behind,
    ahead,
    dirty,
    behindHere: behind,
    aheadHere: ahead,
    dirtyHere: dirty,
    unmerged: 0,
    ...over,
  };
}

function state(status: GitSyncStatus, trackable = 0): SyncTargetState {
  return {
    folderPath: "C:/写し",
    label: "写し",
    works: [{ id: "w", title: "作品", folderPath: "C:/写し" } as WorkEntry],
    status,
    trackable,
  };
}

describe("詳細メニューの同期の入口は「保存・同期」1つ", () => {
  test("「GitHub作品管理」に並ぶ同期の命令は saveAndSync だけ", () => {
    const commands = githubSection().items.map((item) => item.command);
    expect(commands.filter((command) => SYNC_COMMANDS.includes(command))).toEqual([
      "novelai.saveAndSync",
    ]);
  });

  test("ほかの節にも、外した同期の命令は出ていない", () => {
    const all = ACTION_TREE.flatMap((group) =>
      group.entries.flatMap((entry) => (entry.kind === "section" ? entry.items : [entry]))
    ).map((item) => item.command);
    for (const removed of SYNC_COMMANDS.filter((command) => command !== "novelai.saveAndSync")) {
      expect(all, removed).not.toContain(removed);
    }
  });

  test("「保存・同期」の説明に、メニューから外した項目の名前を書かない", () => {
    const detail = findAction("novelai.saveAndSync")?.detail ?? "";
    expect(detail).not.toContain("全作品同期");
    expect(detail).not.toContain("「同期」");
  });

  test("編集者の簡単ステップメニューも、同期の入口は「保存・同期」", () => {
    const entries = EDITOR_STEP_DEFS.flatMap((step) => step.entries);
    expect(entries).toContain("novelai.saveAndSync");
    expect(entries).not.toContain("novelai.gitSync");
    // 説明の文で、メニューに無い「同期」を指さない
    const details = EDITOR_STEP_DEFS.map((step) => step.detail).join("\n");
    expect(details).not.toContain("「同期」");
  });

  test("名前はメニューの定義から引く", () => {
    expect(saveAndSyncLabel()).toBe(findAction("novelai.saveAndSync")?.label);
  });
});

describe("ブラウザ版でも、同期の入口は押せる（ソース管理へ案内する）", () => {
  test("saveAndSync はブラウザ版でも隠さない", () => {
    expect(isCommandAvailableInRuntime("novelai.saveAndSync", false)).toBe(true);
  });

  test("ブラウザ版の案内は、メニューに無い「同期」を指さない", () => {
    const text = describeProcessesBlocked("novelai.setupGithub");
    expect(text).not.toContain("→「同期」");
    expect(text).toContain(`「${saveAndSyncLabel()}」`);
  });

  test("競合の直し方の案内：手元では「保存・同期」、ブラウザ版ではソース管理", () => {
    expect(conflictFixHint(true)).toContain(`「${saveAndSyncLabel()}」`);
    expect(conflictFixHint(true)).not.toContain("「競合解決」");
    expect(conflictFixHint(false)).toContain("ソース管理");
    expect(conflictFixHint(false)).not.toContain("「競合解決」");
  });
});

describe("編集者モードの「保存・同期」は受け取るだけ", () => {
  test("編集者モードでも押せる", () => {
    expect(isCommandAllowed("novelai.saveAndSync", "editor")).toBe(true);
  });

  test("書きかけ・送っていない分・取り込み待ちがあっても、受け取りだけを立てる", () => {
    const plan = planSyncTarget(state(tracked({ behind: 2, dirty: 3 }), 3), { editor: true });
    expect(plan.commit).toBe(false);
    expect(plan.push).toBe(false);
    expect(plan.pull).toBe(true);
  });

  test("受け取るものが無ければ、何もしない（記録も送信もしない）", () => {
    const plan = planSyncTarget(state(tracked({ ahead: 1, dirty: 2 }), 2), { editor: true });
    expect(plan.commit || plan.pull || plan.push).toBe(false);
  });

  test("分かれていれば合わせにいかず、「校閲を終えて返す」へ案内する", () => {
    const plan = planSyncTarget(state(tracked({ ahead: 1, behind: 2 })), { editor: true });
    expect(plan.pull).toBe(false);
    expect(plan.push).toBe(false);
    expect(describeSyncSkips([plan])).toContain(
      `「${findAction("novelai.finishReviewAndReturn")?.label}」`
    );
  });

  test("確認の窓は「送信します」と言わず、送るのは「校閲を終えて返す」だと言う", () => {
    const plan = planSyncTarget(state(tracked({ behind: 2 })), { editor: true });
    const text = describeSyncConfirm([plan], [plan]);
    expect(text.detail).not.toContain("送信します");
    expect(text.detail).not.toContain("送り先が未設定");
    expect(text.detail).toContain(`「${findAction("novelai.finishReviewAndReturn")?.label}」`);
  });

  test("作者モードではこれまでどおり記録して送る", () => {
    const plan = planSyncTarget(state(tracked({ behind: 2, dirty: 3 }), 3));
    expect(plan.commit).toBe(true);
    expect(plan.push).toBe(true);
  });

  test("ステータスバーの一覧などで「保存・同期」を出してよいかも、編集者では偽", () => {
    expect(canSaveAndSync(tracked({ dirty: 1 }), { editor: true })).toBe(false);
    expect(canSaveAndSync(tracked({ dirty: 1 }))).toBe(true);
  });
});

describe("同期まわりの行き止まりを直す", () => {
  test("早送りで取り込んだあと書きかけが食い違ったら、残す文を選ばせる（メニューに無い項目を指さない）", async () => {
    const { describePulledButConflicted, CHOOSE_TEXT_TO_KEEP } = await import(
      "../../../src/core/gitSyncMenuText"
    );
    const text = describePulledButConflicted("作品");
    expect(text.detail).toContain("残す文を選んでください");
    expect(text.detail).not.toContain("GitHub の書き換えを受け取る");
    expect(text.detail).not.toContain("GitHubと同期");
    expect(CHOOSE_TEXT_TO_KEEP).toBe("残す文を選ぶ");
  });
});
