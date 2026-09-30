import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_RESEND_INTERVAL_MINUTES,
  SYNC_BUSY_COMMANDS,
  WAKE_GAP_MS,
  describeResent,
  looksLikeWake,
  normalizeResendIntervalMinutes,
  pickResendTargets,
  resendDecision,
} from "../../../src/core/autoResendPlan";
import {
  readOperationInProgress,
  type GitCommandRunner,
  type GitSyncStatus,
} from "../../../src/core/git";

/**
 * 自動の送り直しの判断（設計書6.15.1。作者の裁定 2026-10-01）。
 *
 * 「送ってよいか」は git を呼ばずに見張りの控えだけで決める。
 * **送らない条件を1つずつ確かめる**——ここが緩むと、分かれた置き場へ
 * 押し込もうとしたり、合流の途中の履歴を外へ出したりする。
 */

function tracked(
  overrides: Partial<Extract<GitSyncStatus, { kind: "tracked" }>> = {}
): GitSyncStatus {
  return {
    kind: "tracked",
    root: "C:/書庫",
    branch: "main",
    upstream: "origin/main",
    behind: 0,
    ahead: 1,
    behindHere: 0,
    aheadHere: 1,
    dirty: 0,
    dirtyHere: 0,
    unmerged: 0,
    ...overrides,
  };
}

describe("送ってよいか（resendDecision）", () => {
  test("記録済みで送れていないだけなら送る", () => {
    expect(resendDecision(tracked({ ahead: 3 }))).toEqual({ send: true, ahead: 3 });
  });

  test("記録していない変更があっても、記録済みの分は送る（書きかけは出ていかない）", () => {
    expect(resendDecision(tracked({ ahead: 1, dirty: 4 }))).toEqual({
      send: true,
      ahead: 1,
    });
  });

  test("送るものが無ければ送らない", () => {
    expect(resendDecision(tracked({ ahead: 0 }))).toEqual({
      send: false,
      reason: "nothing_to_send",
    });
  });

  test("別の環境のほうが進んでいれば送らない", () => {
    expect(resendDecision(tracked({ ahead: 0, behind: 2 }))).toMatchObject({
      send: false,
      reason: "behind",
    });
  });

  test("分かれていれば送らない（合流は作者が押したときだけ）", () => {
    expect(resendDecision(tracked({ ahead: 2, behind: 3 }))).toMatchObject({
      send: false,
      reason: "behind",
    });
  });

  test("競合が残っていれば送らない", () => {
    expect(resendDecision(tracked({ ahead: 2, unmerged: 1 }))).toMatchObject({
      send: false,
      reason: "unmerged",
    });
  });

  test("上流の無い枝・切り離されたHEAD・gitの無い環境では送らない", () => {
    const others: GitSyncStatus[] = [
      { kind: "git_missing" },
      { kind: "not_a_repo" },
      { kind: "detached", root: "C:/書庫" },
      { kind: "no_upstream", root: "C:/書庫", branch: "main", dirty: 0, dirtyHere: 0 },
      { kind: "no_remote", root: "C:/書庫", dirty: 0, dirtyHere: 0 },
      { kind: "failed", detail: "読めない" },
    ];
    for (const status of others) {
      expect(resendDecision(status)).toMatchObject({
        send: false,
        reason: "not_tracked",
      });
    }
  });
});

describe("置き場ごとにまとめる（pickResendTargets）", () => {
  test("同じ置き場の作品は1つにまとめる（書庫で git push を作品の数だけ走らせない）", () => {
    const targets = pickResendTargets([
      { work: "甲", status: tracked({ ahead: 2 }) },
      { work: "乙", status: tracked({ ahead: 2 }) },
    ]);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ root: "C:/書庫", works: ["甲", "乙"], ahead: 2 });
  });

  test("同じ置き場の作品が1つでも遅れを見ていれば、その置き場は送らない", () => {
    const targets = pickResendTargets([
      { work: "甲", status: tracked({ ahead: 2 }) },
      { work: "乙", status: tracked({ ahead: 2, behind: 1 }) },
    ]);
    expect(targets).toEqual([]);
  });

  test("別の置き場は別々に拾い、控えの無い作品は飛ばす", () => {
    const targets = pickResendTargets([
      { work: "甲", status: tracked({ root: "C:/書庫", ahead: 1 }) },
      { work: "乙", status: tracked({ root: "C:/別", ahead: 0 }) },
      { work: "丙", status: undefined },
      { work: "丁", status: tracked({ root: "C:/三つ目", ahead: 4 }) },
    ]);
    expect(targets.map((one) => one.root)).toEqual(["C:/書庫", "C:/三つ目"]);
  });
});

describe("スリープ明けの見分け（looksLikeWake）", () => {
  test("始めたばかり・鼓動どおりなら眠っていない", () => {
    expect(looksLikeWake(undefined, 1_000_000)).toBe(false);
    expect(looksLikeWake(1_000_000, 1_000_000 + 60_000)).toBe(false);
  });

  test("鼓動の間が大きく飛んだら眠っていたと見なす", () => {
    expect(looksLikeWake(1_000_000, 1_000_000 + WAKE_GAP_MS)).toBe(true);
    expect(looksLikeWake(1_000_000, 1_000_000 + 3 * 60 * 60_000)).toBe(true);
  });
});

describe("間隔の丸め", () => {
  test("0・負・数でない値は既定へ戻す（回線を叩き続けない）", () => {
    for (const bad of [0, -3, Number.NaN, "5", undefined, null]) {
      expect(normalizeResendIntervalMinutes(bad)).toBe(DEFAULT_RESEND_INTERVAL_MINUTES);
    }
    expect(normalizeResendIntervalMinutes(15)).toBe(15);
  });
});

describe("送れたときの一言", () => {
  test("件数と置き場を短く言う", () => {
    expect(describeResent([{ label: "書庫", ahead: 2 }])).toContain(
      "送れていなかった 2件を GitHub へ送りました（書庫）"
    );
    expect(
      describeResent([
        { label: "書庫", ahead: 2 },
        { label: "別", ahead: 1 },
      ])
    ).toContain("3件を GitHub へ送りました（2か所）");
    expect(describeResent([])).toBeUndefined();
  });
});

describe("同期の系のコマンド", () => {
  test("並べたIDは package.json に実在する（綴り違いは型検査を素通りする）", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8")
    ) as { contributes: { commands: Array<{ command: string }> } };
    const declared = new Set(manifest.contributes.commands.map((one) => one.command));
    const missing = SYNC_BUSY_COMMANDS.filter((id) => !declared.has(id));
    expect(missing).toEqual([]);
  });
});

describe("途中の操作（readOperationInProgress）", () => {
  const runner =
    (present: string[], broken: string[] = []): GitCommandRunner =>
    async (args) => {
      const ref = args[args.length - 1];
      if (broken.includes(ref)) return { code: 128, stdout: "", stderr: "fatal" };
      return present.includes(ref)
        ? { code: 0, stdout: "abc123\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "" };
    };

  test("何も途中でなければ undefined", async () => {
    expect(await readOperationInProgress("C:/書庫", runner([]))).toBeUndefined();
  });

  test("競合を解いたあと記録する前の合流も「途中」と読む", async () => {
    expect(await readOperationInProgress("C:/書庫", runner(["MERGE_HEAD"]))).toBe(
      "MERGE_HEAD"
    );
    expect(
      await readOperationInProgress("C:/書庫", runner(["CHERRY_PICK_HEAD"]))
    ).toBe("CHERRY_PICK_HEAD");
  });

  test("読めなかったら送らない側へ倒す", async () => {
    expect(
      await readOperationInProgress("C:/書庫", runner([], ["MERGE_HEAD"]))
    ).toContain("読めませんでした");
  });
});
