import { beforeEach, describe, expect, test } from "vitest";
import { workspace } from "../support/vscodeStub";
import { useSyncLog } from "../../../src/features/syncLog";
import {
  logLine,
  setFallbackLogRoot,
  settleLogWrites,
  useLogFile,
} from "../../../src/core/logger";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 書庫をまとめて同期したときの記録は、関わった作品それぞれのログへ書く
 * （作者の裁定 2026-11-05、残課題 J10。設計書5.7.9「書庫のログ」）。
 *
 * 以前は書庫の直下の `.aiwriter/logs/` へ書いていた。書庫の直下は
 * Gitから外す印を足す下ごしらえが要るうえ、作者が作品を開いても同期の結果が
 * 見えなかった。ここでは本物のログ係を通し、実際にどのファイルへ何が
 * 書かれたかを見る。
 */

const works: WorkEntry[] = [
  { id: "w1", title: "いじめられっ子", folderPath: "C:/書庫/いじめられっ子" },
  { id: "w2", title: "ハイエルフ未亡人", folderPath: "C:/書庫/ハイエルフ未亡人" },
] as WorkEntry[];

/** 書き込まれたファイル（区切りと大小を揃えた鍵）→ 中身 */
let disk: Map<string, string>;

const norm = (key: string) => key.replace(/\\/g, "/").toLowerCase();
const logOf = (folder: string) =>
  [...disk.entries()].find(([key]) =>
    norm(key).endsWith(`${norm(folder)}/.aiwriter/logs/actions.log`)
  )?.[1];

beforeEach(() => {
  disk = new Map();
  setFallbackLogRoot("");
  useLogFile(undefined);
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

describe("書庫の同期の記録の書き先", () => {
  test("1作品だけが関わった同期は、その作品のログにだけ残る", async () => {
    await useSyncLog("C:/書庫", works, [works[0]]);
    logLine("同期した");
    await settleLogWrites();

    expect(logOf(works[0].folderPath)).toContain("同期した");
    expect(logOf(works[1].folderPath)).toBeUndefined();
  });

  test("2作品とも関わったなら、両方に同じ行が残る", async () => {
    await useSyncLog("C:/書庫", works, works);
    logLine("同期した");
    await settleLogWrites();

    const first = logOf(works[0].folderPath);
    const second = logOf(works[1].folderPath);
    expect(first).toContain("同期した");
    expect(second).toBe(first);
  });

  test("書庫の直下には、ログも .gitignore も書かない", async () => {
    await useSyncLog("C:/書庫", works, works);
    logLine("同期した");
    await settleLogWrites();

    const underRoot = [...disk.keys()].filter((key) =>
      norm(key).includes("/書庫/.aiwriter/")
    );
    expect(underRoot).toEqual([]);
  });

  test("関わった作品が分からない（指定なし・空）なら、書庫の全作品へ", async () => {
    await useSyncLog("C:/書庫", works);
    logLine("A");
    await useSyncLog("C:/書庫", works, []);
    logLine("B");
    await settleLogWrites();

    expect(logOf(works[0].folderPath)).toContain("B");
    expect(logOf(works[1].folderPath)).toContain("B");
  });

  test("作品ごとに分けたリポジトリなら、これまでどおりその作品のログ", async () => {
    await useSyncLog("C:/書庫/いじめられっ子", [works[0]]);
    logLine("同期した");
    await settleLogWrites();

    expect(logOf(works[0].folderPath)).toContain("同期した");
    expect(logOf(works[1].folderPath)).toBeUndefined();
  });
});
