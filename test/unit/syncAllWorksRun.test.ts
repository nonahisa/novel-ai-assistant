import { beforeEach, describe, expect, test } from "vitest";
import { syncAllWorks } from "../../src/features/syncAllWorks";
import type { GitCommandRunner } from "../../src/core/git";
import type { WorkRegistry } from "../../src/core/workRegistry";
import type { GitSyncMonitorLike } from "../../src/features/gitSyncStub";
import type { WorkEntry } from "../../src/models/types";
import { window } from "./support/vscodeStub";

/**
 * 「作品をすべて同期」を、作り物の git で一通り走らせる（設計書5.5.14）。
 *
 * 実機確認リスト A-15 のうち、**画面に出る中身**——確認が何回出るか、
 * 進捗に何と書くか、どの順に git を呼ぶか、中止したときに何も起きないか
 * ——を機械で見るためのもの。QuickPick や通知が実際に画面へ出ることは
 * 実機に残る。
 *
 * **本物の git は呼ばない。** ここで確かめたいのは手順の並びであって、
 * git そのものの振る舞いではない（そちらは `resolveDivergence.test.ts` が
 * 本物のリポジトリで見ている）。
 */

const library = "C:/書庫";

/** 同じ置き場（書庫）に入っている2作品 */
const works: WorkEntry[] = [
  { id: "w1", title: "いじめられっ子", folderPath: "C:/書庫/いじめられっ子" },
  { id: "w2", title: "ハイエルフ未亡人", folderPath: "C:/書庫/ハイエルフ未亡人" },
] as WorkEntry[];

const registry = { list: () => works } as unknown as WorkRegistry;

let refreshedAll = 0;
const monitor = {
  refreshAll: async () => {
    refreshedAll += 1;
  },
} as unknown as GitSyncMonitorLike;

/** 呼ばれた git の副コマンド（順番どおり） */
let calls: string[][] = [];

/**
 * 記録するものが2件あり、1件遅れていて、1件送っていない置き場。
 *
 * 記録・取り込み・送信の3つが全部立つので、**順番が見える。**
 */
const busyRepo: GitCommandRunner = async (args) => {
  calls.push(args);
  const joined = args.join(" ");
  if (args[0] === "--version") {
    return { code: 0, stdout: "git version 2.55", stderr: "" };
  }
  if (joined === "rev-parse --is-inside-work-tree") {
    return { code: 0, stdout: "true", stderr: "" };
  }
  if (joined === "rev-parse --show-toplevel") {
    return { code: 0, stdout: library, stderr: "" };
  }
  // 記録できる件数（未追跡も含めて数える）。作業ツリーは「きれい」に見せる
  // ——取り込みは未記録の変更が残っていると走らない決まりだからである
  if (joined === "status --porcelain --untracked-files=all") {
    return { code: 0, stdout: " M 本文/001.txt\n M 本文/002.txt\n", stderr: "" };
  }
  if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
  if (joined === "remote") return { code: 0, stdout: "origin", stderr: "" };
  if (args[0] === "symbolic-ref") return { code: 0, stdout: "main", stderr: "" };
  if (joined.startsWith("rev-parse --abbrev-ref")) {
    return { code: 0, stdout: "origin/main", stderr: "" };
  }
  if (args[0] === "rev-list") return { code: 0, stdout: "1\t1", stderr: "" };
  if (args[0] === "config") return { code: 0, stdout: "作者", stderr: "" };
  if (args[0] === "diff") return { code: 1, stdout: "", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};

/** 出た確認・通知の本文（detail も含める） */
let shown: string[] = [];
/** 進捗に出た文言 */
let progressed: string[] = [];
/** 確認の答え（「同期する」で進み、undefined で中止） */
let answer: string | undefined = "同期する";

beforeEach(() => {
  calls = [];
  shown = [];
  progressed = [];
  refreshedAll = 0;
  answer = "同期する";

  Object.assign(window, {
    withProgress: (
      _options: unknown,
      task: (
        progress: { report(value: { message?: string }): void },
        token: { isCancellationRequested: boolean }
      ) => unknown
    ) =>
      Promise.resolve(
        task(
          {
            report: (value) => {
              if (value.message) progressed.push(value.message);
            },
          },
          { isCancellationRequested: false }
        )
      ),
    showInformationMessage: async (message: string, ...rest: unknown[]) => {
      const detail = rest.find(
        (item): item is { detail?: string } =>
          typeof item === "object" && item !== null && "detail" in item
      )?.detail;
      shown.push(detail ? `${message}\n${detail}` : message);
      // ボタンが並んでいるものだけが確認。ただの知らせには答えない
      return rest.some((item) => typeof item === "string") ? answer : undefined;
    },
    showWarningMessage: async (message: string) => {
      shown.push(message);
      return undefined;
    },
  });
});

describe("作品をすべて同期", () => {
  test("置き場が同じなら、確認は1回だけ（実機確認リスト A-15 の代わり）", async () => {
    await syncAllWorks({ registry, monitor, run: busyRepo });

    // ボタン付きの問いは1つ。作品が2つあっても、置き場は1つだから
    const confirms = shown.filter((text) => text.includes("か所を同期します"));
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toContain("1か所を同期します");
    // 一覧には、置き場と中の作品の両方が出る
    expect(confirms[0]).toContain("いじめられっ子");
    expect(confirms[0]).toContain("ハイエルフ未亡人");
    expect(confirms[0]).toContain("記録 2件");
  });

  test("記録 → 取り込み → 送信の順に進む（実機確認リスト A-15 の代わり）", async () => {
    await syncAllWorks({ registry, monitor, run: busyRepo });

    const order = calls
      .map((args) => args[0])
      .filter((name) => name === "commit" || name === "pull" || name === "push");
    expect(order).toEqual(["commit", "pull", "push"]);
  });

  test("進捗に置き場の名前が出る（実機確認リスト A-15 の代わり）", async () => {
    await syncAllWorks({ registry, monitor, run: busyRepo });

    expect(progressed.some((text) => text.includes("書庫"))).toBe(true);
    expect(progressed.some((text) => text.includes("（1/1）"))).toBe(true);
  });

  test("中止すると、記録も取り込みも送信もしない（実機確認リスト A-15 の代わり）", async () => {
    answer = undefined;
    await syncAllWorks({ registry, monitor, run: busyRepo });

    const wrote = calls.filter(
      (args) =>
        args[0] === "commit" ||
        args[0] === "pull" ||
        args[0] === "push" ||
        args[0] === "add"
    );
    expect(wrote).toEqual([]);
    // 状態表示も作り直さない（何も起きていないため）
    expect(refreshedAll).toBe(0);
  });

  test("済んだら、同期の印を作り直す（実機確認リスト A-15 の代わり）", async () => {
    await syncAllWorks({ registry, monitor, run: busyRepo });
    expect(refreshedAll).toBe(1);
  });
});
