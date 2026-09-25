import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { window, workspace } from "../support/vscodeStub";
import type { WorkEntry } from "../../../src/models/types";
import type { GitCommandResult, GitCommandRunner } from "../../../src/core/git";
import type { EpisodeRename } from "../../../src/core/episodeRenumber";
import {
  findUnsavedEpisodes,
  offerIndependentRenameCommit,
  reportRenumberOutcome,
} from "../../../src/features/episodeRenumberShared";
import { emptyLedgerFollowSummary } from "../../../src/features/episodeLedgers";

/**
 * 「名前だけの独立コミット」（設計書6.67.1）の配線と、実行前後の関所。
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
  const run: GitCommandRunner = async (args) => {
    calls.push(args);
    const next = responses.shift() ?? { code: 0, stdout: "", stderr: "" };
    return { code: next.code ?? 0, stdout: next.stdout ?? "", stderr: next.stderr ?? "" };
  };
  // 記録は関数そのものへ持たせる（`as` で型を付け替えると、
  // 実体に `calls` が無いまま通ってしまう）
  return Object.assign(run, { calls });
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

function episodePath(fileName: string): string {
  return path.join(work.folderPath, "本文", fileName);
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

/**
 * `git ls-files -z` の返し方。
 *
 * **区切りのNULは生で書かない**（CLAUDE.md。生のまま置くとgit/grepが
 * バイナリ扱いし、`sourceHygiene.test.ts` が止める）。文字コードから
 * 作る書き方は `sourceHygiene.test.ts` の `BS` と同じ。末尾にも区切りが
 * 付くのが本物の `-z` の出力である。
 */
const NUL = String.fromCharCode(0);
function lsFiles(...relativePaths: string[]): Partial<GitCommandResult> {
  return {
    code: 0,
    stdout: relativePaths.map((entry) => `${entry}${NUL}`).join(""),
  };
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

  test("同意すると、パスを名指ししてステージし、そのパスだけをコミットする", async () => {
    window.showInformationMessage = async () => "コミットする";
    const run = runner([
      ...noRemoteRepoResponses(),
      lsFiles("本文/004.txt", "本文/005.txt"),
      { code: 0 }, // add
      { code: 0 }, // commit
    ]);

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
      episodePath("004.txt"),
      episodePath("003.txt"),
      episodePath("005.txt"),
      episodePath("004.txt"),
    ]);

    // **コミットもパス指定にする。** 作者が別の仕事で index へ載せていた
    // ものを、名前の変更のコミットへ巻き込まない
    const commitCall = run.calls.find((args) => args[0] === "commit");
    expect(commitCall?.slice(0, 4)).toEqual([
      "commit",
      "-m",
      "第3話を削除したため、第3話以降の話数を調整",
      "--",
    ]);
    expect(commitCall?.slice(4)).toEqual(addCall?.slice(2));
  });

  test("Gitがまだ知らない話は、対ごとコミットから外す", async () => {
    window.showInformationMessage = async () => "コミットする";
    const run = runner([
      ...noRemoteRepoResponses(),
      // 005.txt はまだ一度も記録されていない（新しく書いた話）
      lsFiles("本文/004.txt"),
      { code: 0 },
      { code: 0 },
    ]);

    await offerIndependentRenameCommit(
      work,
      [rename("004.txt", "003.txt"), rename("005.txt", "004.txt")],
      "第3話を削除したため、第3話以降の話数を調整",
      run
    );

    const commitCall = run.calls.find((args) => args[0] === "commit");
    expect(commitCall?.slice(4)).toEqual([
      episodePath("004.txt"),
      episodePath("003.txt"),
    ]);
  });

  test("全部が未追跡なら、コミットの話をしない", async () => {
    let asked = false;
    window.showInformationMessage = async () => {
      asked = true;
      return "コミットする";
    };
    const run = runner([...noRemoteRepoResponses(), lsFiles()]);

    await offerIndependentRenameCommit(
      work,
      [rename("004.txt", "003.txt")],
      "第3話…",
      run
    );

    expect(asked).toBe(false);
    expect(run.calls.some((args) => args[0] === "commit")).toBe(false);
  });

  /**
   * **200話規模の作品で、コマンドの長さの上限を超えない**（残課題 F2、設計書6.67）。
   *
   * Windows では1回の起動に渡せるコマンドの長さが 32,767 字まで
   * （CreateProcess の上限）。付け替えたファイルを全部1回の git へ並べると、
   * 作者の本作（219話）の日本語の長い題では上限に届く。届くと git が
   * 起動せず、付け替え自体は済んだのに「名前だけのコミット」が失敗する。
   */
  test("219話・日本語の長いファイル名でも、どの git の命令も上限を超えない", async () => {
    window.showInformationMessage = async () => "コミットする";
    const longWork: WorkEntry = {
      ...work,
      folderPath: path.join(
        "C:",
        "Users",
        "author",
        "Documents",
        "小説",
        "長編ファンタジー作品の置き場"
      ),
    };
    const subtitle = "雪の降る街で出会った少女と約束の場所へ向かう旅路の途中で";
    const fileOf = (n: number) => `第${n}話　${subtitle}.txt`;
    const renames: EpisodeRename[] = Array.from({ length: 219 }, (_, index) => {
      const oldNumber = 219 - index;
      const newNumber = oldNumber + 1;
      return {
        fromPath: path.join(longWork.folderPath, "本文", fileOf(oldNumber)),
        toPath: path.join(longWork.folderPath, "本文", fileOf(newNumber)),
        fromFileName: fileOf(oldNumber),
        toFileName: fileOf(newNumber),
        oldNumber,
        newNumber,
      };
    });
    const allPaths = renames.flatMap((entry) => [entry.fromPath, entry.toPath]);

    /** 渡された命令の、Windows 上の長さの見積もり（引数を引用符で囲み空白で繋ぐ） */
    const commandLength = (args: readonly string[]) =>
      "git.exe".length + args.reduce((total, arg) => total + arg.length + 3, 0);
    // **見積もりが本当に上限を超える台であること**を先に確かめる
    // （超えない台で通っても、何も確かめたことにならない）
    expect(commandLength(["commit", "-m", "調整", "--", ...allPaths])).toBeGreaterThan(32_767);

    /** 命令ごとに、名指しされたパス（引数か、標準入力のNUL区切り） */
    const calls: Array<{ args: string[]; paths: string[] }> = [];
    const pathsOf = (args: readonly string[], input?: string): string[] => {
      if (args.includes("--pathspec-from-file=-")) {
        return (input ?? "").split(NUL).filter((entry) => entry.length > 0);
      }
      const dashes = args.indexOf("--");
      return dashes >= 0 ? args.slice(dashes + 1) : [];
    };
    const run: GitCommandRunner = async (args, _cwd, _timeout, options) => {
      const named = pathsOf(args, options?.input);
      calls.push({ args, paths: named });
      if (args.includes("--is-inside-work-tree")) return { code: 0, stdout: "true", stderr: "" };
      if (args.includes("--show-toplevel")) {
        return { code: 0, stdout: longWork.folderPath, stderr: "" };
      }
      if (args[0] === "ls-files") {
        // 全部が既に記録されている（Gitの知っている話）
        return {
          code: 0,
          stdout: named
            .map((entry) => `${path.relative(longWork.folderPath, entry).replace(/\\/g, "/")}${NUL}`)
            .join(""),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    await offerIndependentRenameCommit(longWork, renames, "第1話を挿入したため、話数を調整", run);

    for (const call of calls) {
      expect(commandLength(call.args), `${call.args[0]} が長すぎる`).toBeLessThan(32_767);
    }
    // **名前の変更は1つのコミットにまとめる**（分けると GitHub 上で改名が割れる）
    const commits = calls.filter((call) => call.args[0] === "commit");
    expect(commits).toHaveLength(1);
    expect(new Set(commits[0].paths)).toEqual(new Set(allPaths));
    // ステージしたものも、付け替えた全部
    const added = calls.filter((call) => call.args[0] === "add").flatMap((call) => call.paths);
    expect(new Set(added)).toEqual(new Set(allPaths));
  });

  test("断ると、何もステージしない", async () => {
    window.showInformationMessage = async () => undefined;
    const run = runner([...noRemoteRepoResponses(), lsFiles("本文/004.txt")]);

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

describe("未保存のエディタの見張り", () => {
  beforeEach(() => {
    workspace.textDocuments = [];
  });

  test("付け替える話に未保存の変更があれば、名前を返す", () => {
    workspace.textDocuments = [
      {
        uri: { fsPath: episodePath("004.txt") },
        isDirty: true,
        getText: () => "",
      },
      {
        uri: { fsPath: episodePath("005.txt") },
        isDirty: false,
        getText: () => "",
      },
    ];

    expect(
      findUnsavedEpisodes([episodePath("004.txt"), episodePath("005.txt")])
    ).toEqual(["004.txt"]);
  });

  test("対象外のファイルの未保存は、関係ない", () => {
    workspace.textDocuments = [
      {
        uri: { fsPath: episodePath("009.txt") },
        isDirty: true,
        getText: () => "",
      },
    ];

    expect(findUnsavedEpisodes([episodePath("004.txt")])).toEqual([]);
  });
});

describe("完了の知らせ", () => {
  beforeEach(() => {
    window.showInformationMessage = async () => undefined;
    window.showWarningMessage = async () => undefined;
    window.showErrorMessage = async () => undefined;
  });

  test("末尾の話を削除したときも、消したことを伝える", () => {
    let seen = "";
    window.showInformationMessage = async (message: string) => {
      seen = message;
      return undefined;
    };

    reportRenumberOutcome({
      action: "削除",
      pivot: 5,
      outcome: { done: [] },
      summary: emptyLedgerFollowSummary(),
      emptyDetail: "後ろに話が無いため付け替えなし",
    });

    expect(seen).toContain("第5話を削除しました");
    expect(seen).toContain("後ろに話が無いため");
  });

  test("付け替えが済んだときは、件数を伝える", () => {
    let seen = "";
    window.showInformationMessage = async (message: string) => {
      seen = message;
      return undefined;
    };

    reportRenumberOutcome({
      action: "挿入",
      pivot: 3,
      outcome: { done: [rename("003.txt", "004.txt")] },
      summary: emptyLedgerFollowSummary(),
    });

    expect(seen).toContain("第3話以降");
    expect(seen).toContain("1件");
  });
});
