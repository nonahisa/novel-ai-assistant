import { afterEach, describe, expect, test, vi } from "vitest";
import * as vscode from "vscode";
import type { GitSyncStatus } from "../../../src/core/git";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 「GitHubと同期」を押したときの一覧の文（実機確認リスト「0.102.7 の画面の見直し」の
 * 【文言】、作者の裁定 2026-10-13 夜「案A」）。
 *
 * 作者の指摘：一覧に開発の言葉（main・分かれています・衝突・退避の枝・未コミット・
 * リモート／ローカル）が出る。題は「◯◯ を GitHub とそろえる」、状態は
 * 「このPCと GitHub の両方で書き換えがあります（GitHub から来る分 N件・
 * このPCから送る分 N件）。同じ所を両方で直した話が N つあります」、項目は
 * 「両方の書き換えを合わせる」「保存してそろえる（ほかの作品もまとめて）」
 * 「いまの原稿を履歴に残す（送らない）」「このPCの書き換えだけ送る」
 * 「GitHub の様子を読み直す（原稿は変えない）」「記録を見る」「取りやめる」。
 *
 * あわせて、一覧がほかの窓へ移っても閉じないこと（`ignoreFocusOut`。同じ見直しの【不具合】）。
 */

vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn(),
  logStep: vi.fn(),
  logLine: vi.fn(),
  useLogFile: vi.fn(),
  showLog: vi.fn(),
}));

const { showGitSyncActions } = await import("../../../src/features/gitSync");
const { nextSetupStep } = await import("../../../src/features/gitOnboarding");

const WORK: WorkEntry = {
  id: "w",
  title: "短編",
  folderPath: "C:\\novels\\短編",
  registeredAt: "2026-10-13T00:00:00.000Z",
};

function tracked(
  over: Partial<Extract<GitSyncStatus, { kind: "tracked" }>> = {}
): GitSyncStatus {
  return {
    kind: "tracked",
    root: "C:/novels/短編",
    branch: "main",
    upstream: "origin/main",
    behind: 0,
    ahead: 0,
    behindHere: 0,
    aheadHere: 0,
    dirty: 0,
    dirtyHere: 0,
    unmerged: 0,
    ...over,
  };
}

const NO_CONFLICTS = { settings: [], manuscripts: [], autoWritten: [], appendOnly: [] };

interface ShownPick {
  items: Array<{ label?: string; description?: string; detail?: string }>;
  options?: vscode.QuickPickOptions;
}

/** 一覧を開いて、出たもの（項目と設定）を返す。何も選ばずに閉じる */
async function openMenu(status: GitSyncStatus): Promise<ShownPick> {
  const shown: ShownPick[] = [];
  vi.spyOn(vscode.window, "showQuickPick").mockImplementation((async (
    items: unknown,
    options?: vscode.QuickPickOptions
  ) => {
    shown.push({ items: (await items) as ShownPick["items"], options });
    return undefined;
  }) as never);
  const monitor = {
    refresh: async () => status,
    knownWorks: () => [WORK],
  };
  await showGitSyncActions(monitor as never, WORK);
  expect(shown).toHaveLength(1);
  return shown[0];
}

/** 画面に出る文をまとめて1つに（題・状態・項目の名前と説明） */
function screenText(pick: ShownPick): string {
  return [
    pick.options?.title ?? "",
    pick.options?.placeHolder ?? "",
    ...pick.items.flatMap((item) => [item.label ?? "", item.description ?? "", item.detail ?? ""]),
  ].join("\n");
}

/** 作者が「開発の言葉」と挙げたもの */
const DEV_WORDS = [
  "main",
  "分かれています",
  "衝突",
  "退避の枝",
  "未コミット",
  "リモート",
  "ローカル",
  "コミット",
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("「GitHubと同期」の一覧の文（案A）", () => {
  test("両方で書き換えがあるとき：題・状態・項目が作者の選んだ文になる", async () => {
    const pick = await openMenu(
      tracked({
        behind: 3,
        ahead: 2,
        behindHere: 3,
        aheadHere: 2,
        conflicts: { ...NO_CONFLICTS, manuscripts: ["短編/本文/第1話.txt"] },
      })
    );

    expect(pick.options?.title).toBe("短編 を GitHub とそろえる");
    expect(pick.options?.placeHolder).toBe(
      "このPCと GitHub の両方で書き換えがあります（GitHub から来る分 3件・このPCから送る分 2件）。" +
        "同じ所を両方で直した話が 1 つあります"
    );
    const labels = pick.items.map((item) => (item.label ?? "").replace(/^\$\([^)]+\)\s*/, ""));
    expect(labels).toEqual([
      "保存してそろえる（ほかの作品もまとめて）",
      "いまの原稿を履歴に残す（送らない）",
      "両方の書き換えを合わせる",
      "このPCの書き換えだけ送る",
      "GitHub の様子を読み直す（原稿は変えない）",
      "記録を見る",
      "取りやめる",
    ]);
    const merge = pick.items.find((item) => item.label?.includes("両方の書き換えを合わせる"));
    expect(`${merge?.description ?? ""}${merge?.detail ?? ""}`).toBe(
      "GitHub の書き換えをこのPCへ持ってきて合わせます。" +
        "同じ所を直した話は、どちらを残すか選べます。" +
        "合わせる前の状態は控えておくので、あとで戻せます。"
    );
  });

  test("どの状態でも、開発の言葉を画面に出さない", async () => {
    const states: GitSyncStatus[] = [
      tracked({ behind: 3, ahead: 2, conflicts: { ...NO_CONFLICTS, manuscripts: ["a.txt"], settings: ["b.json"] } }),
      tracked({ behind: 3, ahead: 2, conflicts: NO_CONFLICTS }),
      tracked({ behind: 3, ahead: 2 }),
      tracked({ behind: 3 }),
      tracked({ ahead: 2 }),
      tracked({ dirty: 4 }),
      tracked({ unmerged: 1 }),
      tracked(),
      { kind: "no_upstream", root: "C:/novels/短編", branch: "main", dirty: 0, dirtyHere: 0 },
      { kind: "no_remote", root: "C:/novels/短編", dirty: 0, dirtyHere: 0 },
      { kind: "detached", root: "C:/novels/短編" } as GitSyncStatus,
      { kind: "failed" } as GitSyncStatus,
    ];
    for (const status of states) {
      const pick = await openMenu(status);
      // 初めての人へ出す準備の項目（「Gitで管理を始める」など）は、この見直しの外
      const setup = nextSetupStep(status)?.label;
      const text = screenText({
        ...pick,
        items: pick.items.filter((item) => item.label !== setup),
      });
      for (const word of DEV_WORDS) {
        expect(text, `${status.kind} の画面に「${word}」が出る：\n${text}`).not.toContain(word);
      }
      vi.restoreAllMocks();
    }
  });

  test("状態ごとの文が同じ調子になる（受け取るだけ・送るだけ・そろっている・履歴に残していない）", async () => {
    expect((await openMenu(tracked({ behind: 3 }))).options?.placeHolder).toBe(
      "GitHub に、このPCへまだ来ていない書き換えが 3件あります"
    );
    vi.restoreAllMocks();
    expect((await openMenu(tracked({ ahead: 2 }))).options?.placeHolder).toBe(
      "このPCに、GitHub へまだ送っていない書き換えが 2件あります"
    );
    vi.restoreAllMocks();
    expect((await openMenu(tracked())).options?.placeHolder).toBe(
      "このPCと GitHub の原稿はそろっています"
    );
    vi.restoreAllMocks();
    expect((await openMenu(tracked({ dirty: 4, ahead: 1 }))).options?.placeHolder).toBe(
      "このPCに、GitHub へまだ送っていない書き換えが 1件あります。" +
        "履歴に残していない書き換えが 4件あります"
    );
  });

  test("受け取るだけのときは「GitHub の書き換えを受け取る」、合わせる項目は出さない", async () => {
    const pick = await openMenu(tracked({ behind: 3 }));
    const labels = pick.items.map((item) => item.label ?? "");
    expect(labels.some((label) => label.includes("GitHub の書き換えを受け取る"))).toBe(true);
    expect(labels.some((label) => label.includes("両方の書き換えを合わせる"))).toBe(false);
  });

  test("同じ所を直したものが調べられなかったときは、そう書く（0件と言わない）", async () => {
    const pick = await openMenu(tracked({ behind: 3, ahead: 2 }));
    expect(pick.options?.placeHolder).toContain(
      "同じ所を両方で直した話があるかは、調べられませんでした"
    );
  });

  test("一覧はほかの窓へ移っても閉じない（ignoreFocusOut）", async () => {
    const pick = await openMenu(tracked({ behind: 3, ahead: 2, conflicts: NO_CONFLICTS }));
    expect(pick.options?.ignoreFocusOut).toBe(true);
  });
});
