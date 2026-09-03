import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { window } from "./support/vscodeStub";
import type { WorkEntry } from "../../src/models/types";
import type { GitCommandResult, GitCommandRunner } from "../../src/core/git";
import type { EpisodeRename } from "../../src/core/episodeRenumber";
import { offerIndependentRenameCommit } from "../../src/features/episodeRenumberShared";

/**
 * 「名前だけの独立コミット」（設計書6.67.1）の配線。
 *
 * 実行順を作る `episodeRenumber.ts` 側はテスト済みなので、ここで確かめる
 * のは「Gitへ何を渡すか」だけ——`-A` を使わず、付け替えたファイルだけを
 * 名指しでステージすること、Git管理下でない作品では何も訊かないこと。
 */

const work: WorkEntry = {
  id: "work_test",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "work"),
  registeredAt: "2026-09-03T00:00:00.000Z",
};

/** 呼ばれたコマンドを記録する差し替え口（`gitSetup.test.ts` と同じ形） */
function runner(
  responses: Array<Partial<GitCommandResult>>
): GitCommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (args: string[]) => {
    calls.push(args);
    const next = responses.shift() ?? { code: 0, stdout: "", stderr: "" };
    return { code: next.code ?? 0, stdout: next.stdout ?? "", stderr: next.stderr ?? "" };
  }) as GitCommandRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

function rename(fromFileName: string, toFileName: string): EpisodeRename {
  return {
    fromPath: path.join(work.folderPath, "本文", fromFileName),
    toPath: path.join(work.folderPath, "本文", toFileName),
    fromFileName,
    toFileName,
    oldNumber: parseInt(fromFileName, 10),
    newNumber: parseInt(toFileName, 10),
  };
}

/** `readSyncStatus` が「リモート無しのリポジトリ」と判定するまでの応答列 */
function noRemoteRepoResponses(): Array<Partial<GitCommandResult>> {
  return [
    { code: 0, stdout: "true" }, // rev-parse --is-inside-work-tree
    { code: 0, stdout: work.folderPath }, // rev-parse --show-toplevel
    { code: 0, stdout: "" }, // status --porcelain
    { code: 0, stdout: "" }, // remote（空＝リモート無し）
  ];
}

describe("名前だけの独立コミット", () => {
  beforeEach(() => {
    window.showInformationMessage = async () => undefined;
  });

  test("Git管理下でない作品では、何も訊かない", async () => {
    let asked = false;
    window.showInformationMessage = async () => {
      asked = true;
      return undefined;
    };
    const run = runner([
      { code: 1 }, // rev-parse --is-inside-work-tree（リポジトリではない）
      { code: 0 }, // --version（gitコマンド自体はある）
    ]);

    await offerIndependentRenameCommit(
      work,
      [rename("004.txt", "003.txt")],
      "第3話を削除したため、第3話以降の話数を調整",
      run
    );

    expect(asked).toBe(false);
    expect(run.calls.some((args) => args[0] === "add")).toBe(false);
  });

  test("付け替えが0件なら、Git管理下でも何も訊かない", async () => {
    let asked = false;
    window.showInformationMessage = async () => {
      asked = true;
      return undefined;
    };
    const run = runner(noRemoteRepoResponses());

    await offerIndependentRenameCommit(work, [], "第3話…", run);

    expect(asked).toBe(false);
    expect(run.calls).toHaveLength(0);
  });

  test("同意すると、付け替えたファイルだけを名指しでステージしてコミットする", async () => {
    window.showInformationMessage = async () => "コミットする";
    const run = runner([...noRemoteRepoResponses(), { code: 0 }, { code: 0 }]);

    await offerIndependentRenameCommit(
      work,
      [rename("004.txt", "003.txt"), rename("005.txt", "004.txt")],
      "第3話を削除したため、第3話以降の話数を調整",
      run
    );

    const addCall = run.calls.find((args) => args[0] === "add");
    expect(addCall).toBeDefined();
    // **`-A` は使わない。** 付け替えた4つのパスだけを名指しでステージする
    expect(addCall).not.toContain("-A");
    expect(addCall?.slice(2)).toEqual([
      path.join(work.folderPath, "本文", "004.txt"),
      path.join(work.folderPath, "本文", "003.txt"),
      path.join(work.folderPath, "本文", "005.txt"),
      path.join(work.folderPath, "本文", "004.txt"),
    ]);

    const commitCall = run.calls.find((args) => args[0] === "commit");
    expect(commitCall).toEqual([
      "commit",
      "-m",
      "第3話を削除したため、第3話以降の話数を調整",
    ]);
  });

  test("断ると、何もステージしない", async () => {
    window.showInformationMessage = async () => undefined;
    const run = runner(noRemoteRepoResponses());

    await offerIndependentRenameCommit(
      work,
      [rename("004.txt", "003.txt")],
      "第3話…",
      run
    );

    expect(run.calls.some((args) => args[0] === "add")).toBe(false);
    expect(run.calls.some((args) => args[0] === "commit")).toBe(false);
  });
});
