import { describe, expect, test } from "vitest";
import {
  parseStatusPorcelainPaths,
  readPendingPaths,
  type GitCommandRunner,
  type GitSyncStatus,
} from "../../../src/core/git";

/**
 * 同期でこの回に関わる道を集める（作者の指摘、2026-10-12 夜）。
 *
 * 「すべて同期」が書庫の中のどの作品の名前を出すかは、ここで集めた道を
 * 作品フォルダーへ当てて決める（`worksTouchedByPaths`）。
 */

const NUL = "\u0000";

function tracked(ahead: number, behind: number): GitSyncStatus {
  return {
    kind: "tracked",
    root: "C:/書庫",
    branch: "main",
    upstream: "origin/main",
    ahead,
    behind,
    aheadHere: ahead,
    behindHere: behind,
    dirty: 0,
    dirtyHere: 0,
    unmerged: 0,
  };
}

describe("status --porcelain -z の道", () => {
  test("改名は、新しい道と元の道の両方を返す", () => {
    const stdout =
      ` M いじめられっ子/本文/001.txt${NUL}` +
      `R  たゆたう鉛/本文/002.txt${NUL}教科書チート/本文/002.txt${NUL}` +
      `?? 事実の照合台/メモ.txt${NUL}`;
    expect(parseStatusPorcelainPaths(stdout)).toEqual([
      "いじめられっ子/本文/001.txt",
      "たゆたう鉛/本文/002.txt",
      "教科書チート/本文/002.txt",
      "事実の照合台/メモ.txt",
    ]);
  });
});

describe("関わる道を集める", () => {
  test("記録待ち・送信待ち・取り込み待ちを合わせ、執筆量の記録は除く", async () => {
    const run: GitCommandRunner = async (args) => {
      const joined = args.join(" ");
      if (joined.startsWith("status")) {
        return {
          code: 0,
          stdout:
            ` M いじめられっ子/本文/001.txt${NUL}` +
            ` M ハイエルフ未亡人/.aiwriter/stats/pc.json${NUL}`,
          stderr: "",
        };
      }
      if (joined === "diff --name-only -z origin/main...HEAD") {
        return { code: 0, stdout: `たゆたう鉛/本文/003.txt${NUL}`, stderr: "" };
      }
      if (joined === "diff --name-only -z HEAD...origin/main") {
        return { code: 0, stdout: `教科書チート/本文/004.txt${NUL}`, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };
    expect(await readPendingPaths("C:/書庫", tracked(1, 1), run)).toEqual([
      "いじめられっ子/本文/001.txt",
      "たゆたう鉛/本文/003.txt",
      "教科書チート/本文/004.txt",
    ]);
  });

  test("送信待ちも取り込み待ちも無ければ、差分は訊かない", async () => {
    const asked: string[] = [];
    const run: GitCommandRunner = async (args) => {
      asked.push(args[0]);
      return { code: 0, stdout: "", stderr: "" };
    };
    expect(await readPendingPaths("C:/書庫", tracked(0, 0), run)).toEqual([]);
    expect(asked).toEqual(["status"]);
  });

  test("読めなければ undefined（作品名は出さない側へ倒す）", async () => {
    const run: GitCommandRunner = async () => ({ code: 128, stdout: "", stderr: "" });
    expect(await readPendingPaths("C:/書庫", tracked(1, 0), run)).toBeUndefined();
  });
});
