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
import {
  logLine,
  setFallbackLogRoot,
  settleLogWrites,
  useLogFile,
  useLogFiles,
} from "../../../src/core/logger";

/**
 * ログの書き先が複数持てること、書き先を決めない処理が前の処理の作品のログへ
 * 紛れないこと（作者の裁定 2026-11-05）。
 */

let written: { path: string; text: string }[] = [];

beforeEach(() => {
  written = [];
  Object.assign(workspace, {
    fs: {
      createDirectory: async () => undefined,
      readFile: async () => {
        throw new Error("まだ無い");
      },
      writeFile: async (uri: { fsPath: string }, data: Uint8Array) => {
        written.push({
          path: uri.fsPath.replace(/\\/g, "/").toLowerCase(),
          text: new TextDecoder().decode(data),
        });
      },
    },
  });
  setFallbackLogRoot("C:/storage");
  useLogFile(undefined);
});

describe("書き先を複数持つ", () => {
  test("useLogFiles は行ごとに全部の書き先へ書く", async () => {
    useLogFiles(["C:/works/a", "C:/works/b"]);
    logLine("両方");
    await settleLogWrites();
    expect(written.map((w) => w.path).sort()).toEqual([
      "c:/works/a/.aiwriter/logs/actions.log",
      "c:/works/b/.aiwriter/logs/actions.log",
    ]);
  });

  test("useLogFile(x) は useLogFiles([x]) と同じ", async () => {
    useLogFile("C:/works/a");
    logLine("1つ");
    await settleLogWrites();
    expect(written.map((w) => w.path)).toEqual([
      "c:/works/a/.aiwriter/logs/actions.log",
    ]);
  });
});

describe("命令の入口で書き先を外す", () => {
  test("extension.ts の registerCommand の包みが、他の命令が無いときに外している", () => {
    // activate は単体で動かせないので、入口の形をソースで見張る
    const source = readFileSync(
      resolve(__dirname, "../../../src/extension.ts"),
      "utf8"
    );
    expect(source).toContain("if (commandsInFlight === 0) useLogFile(undefined);");
    expect(source).toContain("commandsInFlight += 1;");
    expect(source).toContain("commandsInFlight -= 1;");
  });
});

describe("書き先を決めない処理は、前の処理の作品のログへ書かない", () => {
  test("useLogFile(undefined) のあとの行は既定の置き場へ行く", async () => {
    useLogFile("C:/works/前の作品");
    useLogFile(undefined);
    logLine("次の処理");
    await settleLogWrites();
    expect(written.map((w) => w.path)).toEqual([
      "c:/storage/.aiwriter/logs/actions.log",
    ]);
  });
});
