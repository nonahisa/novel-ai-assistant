import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  readdir as nodeReaddir,
  stat as nodeStat,
} from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { FileSystemError, FileType, window, workspace } from "./support/vscodeStub";
import { resolveSyncTarget } from "../../src/features/resolveSyncTarget";
import { recordChanges } from "../../src/features/gitOnboarding";
import {
  buildSyncTarget,
  describeIncludedWorks,
} from "../../src/core/syncTarget";
import type { GitCommandRunner } from "../../src/core/git";
import type { WorkEntry } from "../../src/models/types";

/**
 * 「まとめて1つの置き場にする」（設計書5.7.9）の**出るものの中身**。
 *
 * 実機確認リストの「まとめて1つの置き場にする」を機械へ移すためのもの。
 * QuickPick が実際に開くことは実機に残るが、**どの選択肢がどの順で並び、
 * 選んだ結果どのフォルダーが置き場（＝`git init` する場所）になるか**は
 * ここで確かめられる。
 *
 * フォルダーは本物を作る。`scanCollection` はファイルの有無だけで作品かを
 * 決めるので、作り物のデータで確かめると `stat` の使い方を間違えていても
 * 通ってしまう（`workCollection.test.ts` と同じ理由）。
 */

workspace.fs = {
  stat: async (uri: { fsPath: string }) => {
    try {
      const info = await nodeStat(uri.fsPath);
      return { type: info.isDirectory() ? FileType.Directory : FileType.File };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FileSystemError("見つかりません", "FileNotFound");
      }
      throw error;
    }
  },
  readDirectory: async (uri: { fsPath: string }) => {
    try {
      const names = await nodeReaddir(uri.fsPath);
      return names.map((name) => [name, 1]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FileSystemError("見つかりません", "FileNotFound");
      }
      throw error;
    }
  },
} as never;

let library: string;
let alone: string;
/** 書庫の中の作品（隣にもう1作品ある） */
let inLibrary: WorkEntry;
/** 隣に何も並んでいない作品 */
let lonely: WorkEntry;

async function makeWork(parent: string, name: string): Promise<string> {
  const folder = nodePath.join(parent, name);
  await mkdir(nodePath.join(folder, ".aiwriter"), { recursive: true });
  await writeFile(
    nodePath.join(folder, ".aiwriter", "config.json"),
    JSON.stringify({ workTitle: name }),
    "utf8"
  );
  return folder;
}

beforeAll(async () => {
  const root = await mkdtemp(nodePath.join(os.tmpdir(), "novelai-sync-"));
  library = nodePath.join(root, "書庫");
  await mkdir(library, { recursive: true });
  const first = await makeWork(library, "いじめられっ子");
  await makeWork(library, "ハイエルフ未亡人");

  const solo = nodePath.join(root, "ひとりだけ");
  await mkdir(solo, { recursive: true });
  alone = await makeWork(solo, "孤高の作品");

  inLibrary = {
    id: "w_library",
    title: "いじめられっ子",
    folderPath: first,
    registeredAt: "2026-09-08T00:00:00.000Z",
  };
  lonely = {
    id: "w_alone",
    title: "孤高の作品",
    folderPath: alone,
    registeredAt: "2026-09-08T00:00:00.000Z",
  };
});

afterAll(async () => {
  if (library) {
    await rm(nodePath.dirname(library), { recursive: true, force: true });
  }
});

/** まだリポジトリになっていない、という返事だけをする git */
const notARepo: GitCommandRunner = async (args) => {
  if (args[0] === "--version") return { code: 0, stdout: "git version 2.55", stderr: "" };
  if (args[0] === "rev-parse") return { code: 0, stdout: "false", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};

/** すでに書庫ごとリポジトリになっている、という返事をする git */
function alreadyRepo(root: string): GitCommandRunner {
  return async (args) => {
    if (args[0] === "--version") {
      return { code: 0, stdout: "git version 2.55", stderr: "" };
    }
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
      return { code: 0, stdout: "true", stderr: "" };
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { code: 0, stdout: root, stderr: "" };
    }
    // 送り先はまだ無い（ここでは根が分かれば足りる）
    return { code: 0, stdout: "", stderr: "" };
  };
}

/** 出た選択肢（label と description の対）と、選ぶ番号 */
let offered: Array<{ label: string; description?: string }> = [];
let pickIndex = 0;

beforeEach(() => {
  offered = [];
  pickIndex = 0;
  Object.assign(window, {
    showQuickPick: async (items: Array<Record<string, unknown>>) => {
      offered = items.map((item) => ({
        label: String(item.label ?? ""),
        description:
          typeof item.description === "string" ? item.description : undefined,
      }));
      return items[pickIndex];
    },
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
  });
});

describe("どこを1つの置き場にするか", () => {
  test("書庫の中の作品では、まとめる側が先に出る（実機確認リスト「まとめて1つの置き場にする」の代わり）", async () => {
    await resolveSyncTarget(inLibrary, [inLibrary], notARepo);

    // **まとめる側が1行目。** 既定はそちらで、分けるのは事情があるとき
    expect(offered[0].label).toContain("「書庫」をまとめて1つの置き場にする");
    expect(offered[0].description).toBe("2作品");
    expect(offered[1].label).toContain("「いじめられっ子」だけを置き場にする");
    expect(offered[1].description).toBe("1作品");
  });

  test("まとめる側を選ぶと、置き場は書庫フォルダーになる（実機確認リスト「まとめて1つの置き場にする」の代わり）", async () => {
    pickIndex = 0;
    const target = await resolveSyncTarget(inLibrary, [inLibrary], notARepo);
    // ここが `git init` される場所。作品フォルダーの中ではない
    expect(target?.folderPath).toBe(library);
  });

  test("「この作品だけ」を選ぶと、置き場は作品フォルダーになる（実機確認リスト「まとめて1つの置き場にする」の代わり）", async () => {
    pickIndex = 1;
    const target = await resolveSyncTarget(inLibrary, [inLibrary], notARepo);
    expect(target?.folderPath).toBe(inLibrary.folderPath);
  });

  test("隣に作品が並んでいなければ、何も訊かない（実機確認リスト「まとめて1つの置き場にする」の代わり）", async () => {
    const target = await resolveSyncTarget(lonely, [lonely], notARepo);
    expect(offered).toHaveLength(0);
    expect(target?.folderPath).toBe(lonely.folderPath);
  });

  test("すでにリポジトリの中なら、何も訊かずにその根を使う（実機確認リスト「まとめて1つの置き場にする」の代わり）", async () => {
    const target = await resolveSyncTarget(
      inLibrary,
      [inLibrary],
      alreadyRepo(library)
    );
    expect(offered).toHaveLength(0);
    expect(target?.folderPath).toBe(library);
  });
});

describe("はじめての送信の確認", () => {
  const works: WorkEntry[] = [
    { id: "a", title: "いじめられっ子", folderPath: nodePath.join("C:", "書庫", "a") },
    { id: "b", title: "ハイエルフ未亡人", folderPath: nodePath.join("C:", "書庫", "b") },
  ] as WorkEntry[];

  test("入っている作品を名前で挙げる（実機確認リスト「まとめて1つの置き場にする」の代わり）", () => {
    const target = buildSyncTarget(nodePath.join("C:", "書庫"), works);
    expect(describeIncludedWorks(target)).toBe(
      "入っている作品: いじめられっ子・ハイエルフ未亡人"
    );
  });

  test("1作品しか入っていなければ、その行を出さない（実機確認リスト「まとめて1つの置き場にする」の代わり）", () => {
    const target = buildSyncTarget(works[0].folderPath, works);
    expect(describeIncludedWorks(target)).toBeUndefined();
  });
});

describe("変更を記録する", () => {
  /** 記録の流れを一通り通す git（記録するものが2件ある） */
  const readyToCommit: GitCommandRunner = async (args) => {
    if (args[0] === "status" && args.includes("--untracked-files=all")) {
      return { code: 0, stdout: " M 本文/001.txt\n M 設定/characters/a.json\n", stderr: "" };
    }
    if (args[0] === "config") {
      return { code: 0, stdout: "作者", stderr: "" };
    }
    if (args[0] === "diff") {
      // ステージに差がある（終了コード1）
      return { code: 1, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  test("置き場の名前で言い、記録の説明は日付と件数で作る（実機確認リスト「まとめて1つの置き場にする」の代わり）", async () => {
    const target = buildSyncTarget(nodePath.join("C:", "書庫"), [
      { id: "a", title: "いじめられっ子", folderPath: nodePath.join("C:", "書庫", "a") },
      { id: "b", title: "ハイエルフ未亡人", folderPath: nodePath.join("C:", "書庫", "b") },
    ] as WorkEntry[]);

    const shown: string[] = [];
    let proposed = "";
    Object.assign(window, {
      showInformationMessage: async (message: string) => {
        shown.push(message);
        return undefined;
      },
      showInputBox: async (options: { value?: string }) => {
        proposed = options.value ?? "";
        return options.value;
      },
    });

    const done = await recordChanges(target, readyToCommit);
    expect(done).toBe(true);
    // **既定の説明は「2026-08-24 20:30 の執筆（3件）」の形**
    expect(proposed).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} の執筆（2件）$/);
    expect(shown.join("\n")).toContain("2 件の変更を記録しました。");
  });

  test("記録するものが無いときも、置き場の名前で言う（実機確認リスト「まとめて1つの置き場にする」の代わり）", async () => {
    const target = buildSyncTarget(nodePath.join("C:", "書庫"), [
      { id: "a", title: "いじめられっ子", folderPath: nodePath.join("C:", "書庫", "a") },
      { id: "b", title: "ハイエルフ未亡人", folderPath: nodePath.join("C:", "書庫", "b") },
    ] as WorkEntry[]);

    const shown: string[] = [];
    Object.assign(window, {
      showInformationMessage: async (message: string) => {
        shown.push(message);
        return undefined;
      },
    });

    const nothing: GitCommandRunner = async () => ({
      code: 0,
      stdout: "",
      stderr: "",
    });
    expect(await recordChanges(target, nothing)).toBe(false);
    expect(shown[0]).toBe("書庫 に記録していない変更はありません。");
  });
});
