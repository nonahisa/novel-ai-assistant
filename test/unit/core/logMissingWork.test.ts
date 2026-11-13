import { beforeEach, describe, expect, test } from "vitest";
import { FileType, workspace } from "../support/vscodeStub";
import {
  logLine,
  setFallbackLogRoot,
  settleLogWrites,
  useLogFile,
  useLogFiles,
} from "../../../src/core/logger";

/**
 * 記録係は、フォルダーが見つからない作品のログへ書かない（2026-11-14。設計書5.5.14）。
 *
 * 書く前の `createDirectory` は親を全部作るので、無い作品の `<作品>/.aiwriter/logs/` へ書くと
 * 作品のフォルダーごと作り直す。作り直された作品は「在る」と読まれ、次の同期で守りが効かない
 * （本物の git で、分岐合流・無い作品の取り込み・初回の記録の途中で起きた）。
 * その行は保管庫のログへ回して失わない。
 */

const norm = (key: string) => key.replace(/\\/g, "/").toLowerCase();
let folders: Set<string>;
let created: string[];
let written: { path: string; text: string }[];

beforeEach(() => {
  folders = new Set(["c:/works", "c:/works/在る作品", "c:/storage"]);
  created = [];
  written = [];
  Object.assign(workspace, {
    fs: {
      stat: async (uri: { fsPath: string }) => {
        if (!folders.has(norm(uri.fsPath))) {
          throw Object.assign(new Error("無い"), { code: "FileNotFound" });
        }
        return { type: FileType.Directory, size: 0, mtime: 0, ctime: 0 };
      },
      createDirectory: async (uri: { fsPath: string }) => {
        created.push(norm(uri.fsPath));
      },
      readFile: async () => {
        throw new Error("まだ無い");
      },
      writeFile: async (uri: { fsPath: string }, data: Uint8Array) => {
        written.push({ path: norm(uri.fsPath), text: new TextDecoder().decode(data) });
      },
    },
  });
  setFallbackLogRoot("C:/storage");
  useLogFile(undefined);
});

describe("フォルダーが見つからない作品へは書かない", () => {
  test("無い作品へ向けた行は、作品のフォルダーを作らずに保管庫のログへ入る", async () => {
    useLogFile("C:/works/移した作品");
    logLine("取り込みを止めた");
    await settleLogWrites();
    useLogFile(undefined);
    expect(created.some((one) => one.startsWith("c:/works/移した作品"))).toBe(false);
    expect(written.map((one) => one.path)).toEqual(["c:/storage/.aiwriter/logs/actions.log"]);
    expect(written[0].text).toContain("取り込みを止めた");
    expect(written[0].text).toContain("作品のフォルダーが見つからない");
  });

  test("在る作品で logs だけ無いときは、今までどおり作って書く", async () => {
    useLogFile("C:/works/在る作品");
    logLine("記録した");
    await settleLogWrites();
    useLogFile(undefined);
    expect(created).toEqual(["c:/works/在る作品/.aiwriter/logs"]);
    expect(written.map((one) => one.path)).toEqual([
      "c:/works/在る作品/.aiwriter/logs/actions.log",
    ]);
  });

  test("書き先が複数なら、無い作品だけ外れて保管庫へ回る", async () => {
    useLogFiles(["C:/works/在る作品", "C:/works/移した作品"]);
    logLine("書庫の同期");
    await settleLogWrites();
    useLogFile(undefined);
    expect(created.some((one) => one.startsWith("c:/works/移した作品"))).toBe(false);
    expect(written.map((one) => one.path).sort()).toEqual([
      "c:/storage/.aiwriter/logs/actions.log",
      "c:/works/在る作品/.aiwriter/logs/actions.log",
    ]);
    for (const one of written) expect(one.text).toContain("書庫の同期");
  });
});
