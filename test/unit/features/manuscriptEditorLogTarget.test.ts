import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

// ログの書き先の作品は在るものとして扱う（作り物の道はディスクに無い）。無い作品へ書かない決まりは
// `core/logMissingWork.test.ts` が見る（2026-11-14）
vi.mock("../../../src/core/workFolderPresence", () => ({
  isWorkFolderPresent: async () => true,
  findMissingWorks: async () => [],
}));
import { workspace } from "../support/vscodeStub";

/**
 * 原稿エディターの記録は、**その原稿の作品の `actions.log` へ**入る
 * （作者の裁定 2026-11-05「約80か所を全部直す」のうち、原稿エディターの分）。
 *
 * 0.127.3 で命令の入口が書き先を外すようにしたため、書き先を決めずに書く行は
 * 保管庫の記録へ行く。原稿エディターは作品の話を扱うのに書き先を決めていなかった。
 * 共有の書き先は動かさず、呼び出しごとに作品を引いて書く。
 */

vi.mock("vscode", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    commands: { executeCommand: () => Promise.resolve(undefined) },
    window: {
      ...(actual.window as Record<string, unknown>),
      tabGroups: { all: [], activeTabGroup: undefined },
    },
  };
});

import {
  logForFile,
  openManuscriptFile,
  setManuscriptLogWorkOf,
} from "../../../src/features/manuscriptTab";
import {
  setFallbackLogRoot,
  settleLogWrites,
  useLogFile,
} from "../../../src/core/logger";
import type { WorkEntry } from "../../../src/models/types";

const work = { id: "w1", title: "作品", folderPath: "C:/書庫/作品" } as WorkEntry;

let disk: Map<string, string>;
const norm = (key: string) => key.replace(/\\/g, "/").toLowerCase();
const logOf = (folder: string) =>
  [...disk.entries()].find(([key]) =>
    norm(key).endsWith(`${norm(folder)}/.aiwriter/logs/actions.log`)
  )?.[1];

beforeEach(() => {
  disk = new Map();
  setFallbackLogRoot("C:/storage");
  useLogFile(undefined);
  setManuscriptLogWorkOf((filePath) =>
    norm(filePath).startsWith("c:/書庫/作品/") ? work : undefined
  );
  Object.assign(workspace, {
    fs: {
      createDirectory: async () => undefined,
      readFile: async (uri: { fsPath: string }) => {
        const found = disk.get(norm(uri.fsPath));
        if (found === undefined) throw new Error("まだ無い");
        return new TextEncoder().encode(found);
      },
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        disk.set(norm(uri.fsPath), new TextDecoder().decode(bytes));
      },
    },
  });
});

describe("原稿エディターの記録の書き先", () => {
  test("作品の話の失敗は、その作品の actions.log に入る", async () => {
    logForFile("C:/書庫/作品/第1話.txt", "原稿エディタ：打った内容を当てられませんでした");
    await settleLogWrites();

    expect(logOf("C:/書庫/作品")).toContain("打った内容を当てられませんでした");
    // 保管庫の記録には入らない
    expect(logOf("C:/storage")).toBeUndefined();
  });

  test("原稿を開く共通の口の行も、その作品の記録に入る", async () => {
    await openManuscriptFile("C:/書庫/作品/第2話.txt", "novelAi.manuscript");
    await settleLogWrites();

    expect(logOf("C:/書庫/作品")).toContain("第2話.txt のタブが無いので");
  });

  test("登録外のファイルは、これまでどおり保管庫の記録へ", async () => {
    logForFile("C:/どこか/メモ.txt", "原稿エディタ：登録外の行");
    await settleLogWrites();

    expect(logOf("C:/storage")).toContain("登録外の行");
    expect(logOf("C:/書庫/作品")).toBeUndefined();
  });

  test("共有の書き先を動かさない（ほかの命令の行が作品へ紛れない）", async () => {
    logForFile("C:/書庫/作品/第1話.txt", "原稿エディタ：作品の行");
    // 共有の書き先は保管庫のまま。作品を決めずに書いた行は作品に入らない
    const { logLine } = await import("../../../src/core/logger");
    logLine("別の命令の行");
    await settleLogWrites();

    expect(logOf("C:/書庫/作品")).not.toContain("別の命令の行");
    expect(logOf("C:/storage")).toContain("別の命令の行");
  });
});

describe("原稿エディターのソース", () => {
  test("作品の話を扱う行は logForFile を通す（logLine の直書きは作品を持たない2か所と作成だけ）", () => {
    const source = readFileSync(
      resolve(__dirname, "../../../src/features/manuscriptEditor.ts"),
      "utf8"
    );
    const direct = source.match(/\blogLine\(/g) ?? [];
    // 作品が引けないときの倒れ先2（警告・logForDocument）＋ファイルを持たない
    // 控えの書き込み失敗1＋作成直後（useLogFile で作品を向けた直後）1
    expect(direct.length).toBe(4);
    const tab = readFileSync(
      resolve(__dirname, "../../../src/features/manuscriptTab.ts"),
      "utf8"
    );
    // 共通の口の中の logLine は logForFile の倒れ先の1つだけ
    expect((tab.match(/\blogLine\(/g) ?? []).length).toBe(1);
  });
});
