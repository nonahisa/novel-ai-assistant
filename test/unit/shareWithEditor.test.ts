import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FileType, workspace } from "./support/vscodeStub";
import { copyForEditor } from "../../src/features/shareWithEditor";
import { isNestedLocation, isSameLocation } from "../../src/core/locationCompare";
import { RECOVERY_DIRECTORY_NAME } from "../../src/core/atomicWrite";
import { workPaths } from "../../src/core/workRegistry";
import type { WorkEntry } from "../../src/models/types";

/**
 * 編集部へ渡す（設計書5.6.11）。
 *
 * 確かめるのは2つ。
 *
 * - **渡す中身**：回復用の退避やキャッシュが編集部の手元へ行かないこと。
 *   直す前の版が5世代ぶん一緒に行くと、どれが今の原稿か分からなくなる
 * - **置き場の判定**：作品フォルダーの中を選ばれたら断ること。すり抜けると
 *   入れ子のリポジトリができ、書庫の側へ巻き込まれる
 */

describe("編集用フォルダーの置き場の判定", () => {
  const work = "C:\\Novels\\氷の街";

  test("作品フォルダーの中は入れ子", () => {
    expect(isNestedLocation("C:\\Novels\\氷の街\\編集用", work)).toBe(true);
  });

  test("作品フォルダーそのものも断る", () => {
    // そこへ置けば、作品フォルダー自身が編集用リポジトリになる
    expect(isNestedLocation(work, work)).toBe(true);
  });

  test("区切りが円記号でも斜線でも同じに見る", () => {
    expect(isNestedLocation("C:/Novels/氷の街/編集用", work)).toBe(true);
  });

  test("名前の前半が同じだけなら入れ子ではない", () => {
    // 区切りを足さずに前方一致で見ると、「いじめ」の中に
    // 「いじめられっ子」が入っていることになる
    expect(isNestedLocation("C:\\Novels\\いじめられっ子", "C:\\Novels\\いじめ")).toBe(
      false
    );
  });

  test("隣に置くのは入れ子ではない", () => {
    expect(isNestedLocation("C:\\Novels\\氷の街-編集用", work)).toBe(false);
  });

  test.skipIf(process.platform !== "win32")(
    "大文字小文字が違うだけの道も断る（Windows）",
    () => {
      // 置き場は作者がダイアログで選ぶので、登録時の `folderPath` と
      // 綴りだけが違う道になりうる。Windowsでは同じフォルダーである
      expect(isNestedLocation("c:\\novels\\氷の街\\編集用", work)).toBe(true);
      expect(isSameLocation("c:\\NOVELS\\氷の街", work)).toBe(true);
    }
  );
});

describe("copyForEditor", () => {
  let root = "";
  let destination = "";

  const work = (): WorkEntry => ({
    id: "work_test",
    title: "氷の街",
    folderPath: root,
    registeredAt: "2026-09-11T00:00:00.000Z",
  });

  /** 作品フォルダーの中にファイルを1つ作る */
  const put = async (relative: string, text: string): Promise<void> => {
    const target = nodePath.join(root, relative);
    await fsp.mkdir(nodePath.dirname(target), { recursive: true });
    await fsp.writeFile(target, text, "utf8");
  };

  /** 編集用フォルダーの中に在るか */
  const copied = async (relative: string): Promise<boolean> => {
    try {
      await fsp.stat(nodePath.join(destination, relative));
      return true;
    } catch {
      return false;
    }
  };

  const readCopied = (relative: string): Promise<string> =>
    fsp.readFile(nodePath.join(destination, relative), "utf8");

  const share = () =>
    copyForEditor(workPaths(work()), destination, undefined, undefined);

  beforeEach(async () => {
    // **本物のファイルシステムで走らせる。** 写しはフォルダーごと
    // （`copy` の recursive）なので、作り物の記憶上の円盤では
    // 本番と違う写り方をしてしまう
    const base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "novelai-share-"));
    root = nodePath.join(base, "氷の街");
    destination = nodePath.join(base, "氷の街-編集用");
    await fsp.mkdir(root, { recursive: true });

    workspace.fs = {
      createDirectory: async (uri: { fsPath: string }) => {
        await fsp.mkdir(uri.fsPath, { recursive: true });
      },
      stat: async (uri: { fsPath: string }) => {
        const stat = await fsp.stat(uri.fsPath);
        return {
          type: stat.isDirectory() ? FileType.Directory : FileType.File,
          size: stat.size,
        };
      },
      readFile: async (uri: { fsPath: string }) =>
        new Uint8Array(await fsp.readFile(uri.fsPath)),
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        await fsp.mkdir(nodePath.dirname(uri.fsPath), { recursive: true });
        await fsp.writeFile(uri.fsPath, bytes);
      },
      readDirectory: async (uri: { fsPath: string }) => {
        const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
        return entries.map((entry) => [
          entry.name,
          entry.isDirectory() ? FileType.Directory : FileType.File,
        ]);
      },
      delete: async (
        uri: { fsPath: string },
        options?: { recursive?: boolean }
      ) => {
        await fsp.rm(uri.fsPath, {
          recursive: options?.recursive ?? false,
          force: true,
        });
      },
      copy: async (source: { fsPath: string }, target: { fsPath: string }) => {
        await fsp.cp(source.fsPath, target.fsPath, {
          recursive: true,
          force: true,
        });
      },
    } as unknown as typeof workspace.fs;
  });

  afterEach(async () => {
    workspace.fs = {} as typeof workspace.fs;
    try {
      await fsp.rm(nodePath.dirname(root), { recursive: true, force: true });
    } catch {
      // 消せなくてもテストの結果には関わらない（一時フォルダーである）
    }
  });

  test("回復用の退避は、写したあとに消えている", async () => {
    await put(nodePath.join("本文", "001.txt"), "ゆき");
    await put(nodePath.join("設定", "characters", "chr_001.json"), "{}");
    // 退避は元のファイルと同じ階層にできる。本文の下にも設定の下にもできる
    await put(
      nodePath.join("設定", RECOVERY_DIRECTORY_NAME, "old.json"),
      "{}"
    );
    await put(
      nodePath.join("設定", "characters", RECOVERY_DIRECTORY_NAME, "old.json"),
      "{}"
    );
    await put(
      nodePath.join("本文", RECOVERY_DIRECTORY_NAME, "001.txt.bak"),
      "まえの版"
    );

    await share();

    expect(await copied(nodePath.join("本文", "001.txt"))).toBe(true);
    expect(await copied(nodePath.join("設定", "characters", "chr_001.json"))).toBe(
      true
    );
    expect(await copied(nodePath.join("設定", RECOVERY_DIRECTORY_NAME))).toBe(
      false
    );
    expect(
      await copied(
        nodePath.join("設定", "characters", RECOVERY_DIRECTORY_NAME)
      )
    ).toBe(false);
    expect(await copied(nodePath.join("本文", RECOVERY_DIRECTORY_NAME))).toBe(
      false
    );
  });

  test("キャッシュとログは写らない。設定ファイルは写る", async () => {
    await put(nodePath.join("本文", "001.txt"), "ゆき");
    await put(nodePath.join(".aiwriter", "config.json"), '{"manuscriptDir":"本文"}');
    await put(nodePath.join(".aiwriter", "cache", "chunks.json"), "[]");
    await put(nodePath.join(".aiwriter", "logs", "failure.log"), "だめ");

    await share();

    expect(await copied(nodePath.join(".aiwriter", "config.json"))).toBe(true);
    expect(await copied(nodePath.join(".aiwriter", "cache"))).toBe(false);
    expect(await copied(nodePath.join(".aiwriter", "logs"))).toBe(false);
  });

  test("作品側で消した話は、送り直すと編集用からも消える", async () => {
    await put(nodePath.join("本文", "001.txt"), "いち");
    await put(nodePath.join("本文", "002.txt"), "に");
    await share();
    expect(await copied(nodePath.join("本文", "002.txt"))).toBe(true);

    await fsp.rm(nodePath.join(root, "本文", "002.txt"));
    await share();

    expect(await copied(nodePath.join("本文", "001.txt"))).toBe(true);
    // 無い話が残り続けると、編集部は消えた話を校閲することになる
    expect(await copied(nodePath.join("本文", "002.txt"))).toBe(false);
  });

  test("編集部の提案は、送り直しても消えない", async () => {
    const proposals = nodePath.join(".aiwriter", "proposals", "proposals.jsonl");
    await put(nodePath.join("本文", "001.txt"), "いち");
    await put(proposals, `${JSON.stringify({ kind: "proposal", id: "a" })}\n`);
    await share();

    // 編集部が1件足した状態を作る
    await fsp.appendFile(
      nodePath.join(destination, proposals),
      `${JSON.stringify({ kind: "proposal", id: "b" })}\n`,
      "utf8"
    );

    await share();

    const merged = await readCopied(proposals);
    expect(merged).toContain('"id":"a"');
    expect(merged).toContain('"id":"b"');
  });
});
