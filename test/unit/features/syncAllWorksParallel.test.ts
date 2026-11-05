import { beforeEach, describe, expect, test } from "vitest";
import { syncAllWorks } from "../../../src/features/syncAllWorks";
import type { GitCommandRunner } from "../../../src/core/git";
import type { WorkRegistry } from "../../../src/core/workRegistry";
import type { GitSyncMonitorLike } from "../../../src/features/gitSyncStub";
import type { WorkEntry } from "../../../src/models/types";
import { window } from "../support/vscodeStub";

/**
 * 置き場がたくさんあるときの、状態読みの並べ方（作者の裁定 2026-11-05 案A）。
 *
 * 置き場ごとの状態読みを同時に走らせて確認の窓までを速くする。ただし
 * - 窓の中身（置き場の並び・数）は直列だったときと同じ
 * - 1つの置き場の失敗が他を止めない
 * - git を同時に起こす数は上限（4）を超えない
 * を、作り物の git で見る。
 */

const PLACES = 7;
const places: WorkEntry[] = Array.from({ length: PLACES }, (_, i) => ({
  id: `w${i}`,
  title: `作品${i}`,
  folderPath: `C:/置き場${i}/作品${i}`,
})) as WorkEntry[];
const registry = { list: () => places } as unknown as WorkRegistry;
const monitor = { refreshAll: async () => {} } as unknown as GitSyncMonitorLike;

/** 置き場の番号（cwd から読む） */
function placeOf(cwd: string): number {
  const match = /置き場(\d+)/.exec(cwd);
  return match ? Number(match[1]) : -1;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let running = 0;
let peak = 0;
/** 置き場3は git のリポジトリでない（失敗の扱いを見る） */
const NOT_A_REPO = 3;

/** 置き場 i は「記録 i+1 件」。遅さは逆順にして、完了順と並び順を食い違わせる */
const runner: GitCommandRunner = async (args, cwd) => {
  const joined = args.join(" ");
  // 根の確かめと fetch は、今回の並べ替えの対象外（もとから同時）
  const counted = joined !== "rev-parse --show-toplevel" && args[0] !== "fetch";
  if (counted) {
    running += 1;
    peak = Math.max(peak, running);
  }
  try {
    const n = placeOf(cwd);
    await sleep((PLACES - n) * 3);
    const root = `C:/置き場${n}`;
    if (args[0] === "--version") return { code: 0, stdout: "git version 2.55", stderr: "" };
    if (n === NOT_A_REPO && args[0] === "rev-parse") {
      return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
    }
    if (joined === "rev-parse --is-inside-work-tree --show-toplevel") {
      return { code: 0, stdout: `true\n${root}`, stderr: "" };
    }
    if (joined === "rev-parse --show-toplevel") return { code: 0, stdout: root, stderr: "" };
    if (joined === "status --porcelain --untracked-files=all") {
      const lines = Array.from({ length: n + 1 }, (_, k) => ` M 本文/${k}.txt`).join("\n");
      return { code: 0, stdout: `${lines}\n`, stderr: "" };
    }
    if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (joined === "remote") return { code: 0, stdout: "origin", stderr: "" };
    if (args[0] === "symbolic-ref") return { code: 0, stdout: "main", stderr: "" };
    if (joined.startsWith("rev-parse --abbrev-ref")) {
      return { code: 0, stdout: "origin/main", stderr: "" };
    }
    if (args[0] === "rev-list") return { code: 0, stdout: "0\t0", stderr: "" };
    if (args[0] === "config") return { code: 0, stdout: "作者", stderr: "" };
    if (args[0] === "diff") return { code: 1, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  } finally {
    if (counted) running -= 1;
  }
};

let shown: string[] = [];

beforeEach(() => {
  running = 0;
  peak = 0;
  shown = [];
  Object.assign(window, {
    withProgress: (
      _options: unknown,
      task: (
        progress: { report(value: { message?: string }): void },
        token: { isCancellationRequested: boolean }
      ) => unknown
    ) =>
      Promise.resolve(task({ report: () => {} }, { isCancellationRequested: false })),
    showInformationMessage: async (message: string, ...rest: unknown[]) => {
      const detail = rest.find(
        (item): item is { detail?: string } =>
          typeof item === "object" && item !== null && "detail" in item
      )?.detail;
      shown.push(detail ? `${message}\n${detail}` : message);
      return undefined; // 確認は押さずに閉じる（同期しない）
    },
    showWarningMessage: async (message: string) => {
      shown.push(message);
      return undefined;
    },
  });
});

describe("置き場が多いときの確認の窓", () => {
  test("置き場の並びと件数は登録の順のまま・失敗した置き場が他を止めない", async () => {
    await syncAllWorks({ registry, monitor, run: runner });

    const confirm = shown.find((text) => text.includes("か所を同期します"));
    expect(confirm).toBeDefined();
    const text = confirm as string;
    // リポジトリでない置き場3は、同期する側に入らず「以下は同期しません」に回る。他の6か所は入る
    expect(text).toContain(`${PLACES - 1}か所を同期します`);
    const order = [0, 1, 2, 4, 5, 6].map((n) => text.indexOf(`作品${n}`));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text.slice(0, text.indexOf("以下は同期しません"))).not.toContain("作品3");
    expect(text).toContain("作品3：Gitで管理していません");
    // 件数は置き場ごとの値（取り違えていない）
    for (const n of [0, 1, 2, 4, 5, 6]) {
      expect(text).toContain(`記録 ${n + 1}件`);
    }
  });

  test("git を同時に起こす数は上限（4）を超えず、実際に重なる", async () => {
    await syncAllWorks({ registry, monitor, run: runner });
    expect(peak).toBeLessThanOrEqual(4);
    // 直列のままなら 1。並べ替えが効いていること
    expect(peak).toBeGreaterThan(1);
  });
});
