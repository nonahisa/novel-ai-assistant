import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FileType, workspace } from "../support/vscodeStub";
import type { GitCommandResult, GitCommandRunner } from "../../../src/core/git";
import {
  isOnlyAppendedIgnoreRules,
  rescueEditorGitignore,
} from "../../../src/features/editorGitignoreRescue";
import { ensureOnUseIgnoreRule, IME_READINGS_IGNORE_RULE } from "../../../src/core/workRegistry";

/**
 * 編集者へ渡した写しの `.gitignore`（編集者役の実機 2026-11-01）。
 *
 * **起きたこと**：kmizu さんの画面（0.120.0・編集者モード）で、下の帯が「未取得 1 / 未記録 1」の
 * まま、作者が送った採否が入らなかった。写しの `.gitignore` の末尾は、作者の
 * `novelai.git.syncCache: true` で `!.aiwriter/cache/`。編集者の既定（同期しない）は
 * 登録の時点（「編集者として参加」はまだ作者モード）で `.aiwriter/cache/` を足す。
 * 「校閲を終えて返す」は `.aiwriter/` しか記録しないので、この変更が永久に未記録で残り、
 * 開いたときの点検が「未記録があるので取り込まない」で止まり続けた。
 *
 * 本物のファイルシステムで、作者の写しと同じ形の `.gitignore` を置いて確かめる。
 */

/** 作者の写しの `.gitignore`（実データの末尾2行を含む形） */
const AUTHOR_GITIGNORE =
  ".aiwriter/cache/\n.aiwriter/logs/\n.aiwriter/generated/\n!.aiwriter/cache/\n" +
  ".aiwriter/reports/\n.aiwriter/imeReadings.json\n";

describe("拡張機能が足した行だけか（純粋関数）", () => {
  test("作者の写しの末尾に `.aiwriter/cache/` を足しただけなら、足した形と見る", () => {
    expect(isOnlyAppendedIgnoreRules(AUTHOR_GITIGNORE, `${AUTHOR_GITIGNORE}.aiwriter/cache/\n`)).toBe(
      true
    );
  });

  test("改行の形が違っても（記録は LF・作業木は CRLF）同じに見る", () => {
    const crlf = `${AUTHOR_GITIGNORE}.aiwriter/cache/\n`.replace(/\n/g, "\r\n");
    expect(isOnlyAppendedIgnoreRules(AUTHOR_GITIGNORE, crlf)).toBe(true);
  });

  test("知らない行が1つでもあれば触らない（編集者が手で書いたかもしれない）", () => {
    expect(
      isOnlyAppendedIgnoreRules(AUTHOR_GITIGNORE, `${AUTHOR_GITIGNORE}.aiwriter/cache/\nmemo.txt\n`)
    ).toBe(false);
  });

  test("末尾への追記でない変更（途中の行を消した等）は触らない", () => {
    expect(
      isOnlyAppendedIgnoreRules(AUTHOR_GITIGNORE, AUTHOR_GITIGNORE.replace(".aiwriter/logs/\n", ""))
    ).toBe(false);
  });

  test("差が無ければ戻すものも無い", () => {
    expect(isOnlyAppendedIgnoreRules(AUTHOR_GITIGNORE, AUTHOR_GITIGNORE)).toBe(false);
  });
});

describe("写しの `.gitignore` を書かない・足してしまった分を戻す", () => {
  let base = "";
  let copy = "";

  const put = async (relative: string, text: string) => {
    const target = nodePath.join(copy, relative);
    await fsp.mkdir(nodePath.dirname(target), { recursive: true });
    await fsp.writeFile(target, text, "utf8");
  };
  const read = (relative: string) => fsp.readFile(nodePath.join(copy, relative), "utf8");

  beforeEach(async () => {
    base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "novelai-editor-gitignore-"));
    copy = nodePath.join(base, "たゆたう鉛-編集用");
    await fsp.mkdir(copy, { recursive: true });
    workspace.fs = {
      createDirectory: async (uri: { fsPath: string }) => {
        await fsp.mkdir(uri.fsPath, { recursive: true });
      },
      stat: async (uri: { fsPath: string }) => {
        const stat = await fsp.stat(uri.fsPath);
        return { type: stat.isDirectory() ? FileType.Directory : FileType.File, size: stat.size };
      },
      readFile: async (uri: { fsPath: string }) => new Uint8Array(await fsp.readFile(uri.fsPath)),
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        await fsp.writeFile(uri.fsPath, bytes);
      },
    } as unknown as typeof workspace.fs;
  });

  afterEach(async () => {
    workspace.fs = {} as typeof workspace.fs;
    await fsp.rm(base, { recursive: true, force: true }).catch(() => undefined);
  });

  /** 写しの印（`editor-share-manifest.json` があり `editing.json` が無い） */
  const markAsEditorCopy = () => put(".aiwriter/editor-share-manifest.json", "{}");

  test("写しでは、使った作品にだけ足す行も `.gitignore` に足さない", async () => {
    await markAsEditorCopy();
    await put(".gitignore", AUTHOR_GITIGNORE.replace(".aiwriter/imeReadings.json\n", ""));
    const before = await read(".gitignore");

    await ensureOnUseIgnoreRule(copy, IME_READINGS_IGNORE_RULE);

    expect(await read(".gitignore")).toBe(before);
  });

  test("作者の作品（写しの印が無い）では、今までどおり足す", async () => {
    await put(".gitignore", ".aiwriter/cache/\n");

    await ensureOnUseIgnoreRule(copy, IME_READINGS_IGNORE_RULE);

    expect(await read(".gitignore")).toContain(IME_READINGS_IGNORE_RULE);
  });

  /** git の代役：`.gitignore` が変わっていると答え、記録済みの中身は AUTHOR_GITIGNORE */
  function fakeGit(calls: string[][]): GitCommandRunner {
    return async (args): Promise<GitCommandResult> => {
      calls.push(args);
      if (args[0] === "status") return { code: 0, stdout: " M .gitignore\n", stderr: "" };
      if (args[0] === "show") return { code: 0, stdout: AUTHOR_GITIGNORE, stderr: "" };
      if (args[0] === "checkout") {
        await put(".gitignore", AUTHOR_GITIGNORE);
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };
  }

  test("0.120.0 が足した `.aiwriter/cache/` だけなら、記録済みの中身へ戻す（取り込みが進む）", async () => {
    await markAsEditorCopy();
    await put(".gitignore", `${AUTHOR_GITIGNORE}.aiwriter/cache/\n`);
    const calls: string[][] = [];

    expect(await rescueEditorGitignore(copy, [copy], fakeGit(calls))).toBe("restored");
    expect(calls.map((args) => args[0])).toEqual(["status", "show", "checkout"]);
    expect(await read(".gitignore")).toBe(AUTHOR_GITIGNORE);
  });

  test("知らない行があれば触らない", async () => {
    await markAsEditorCopy();
    await put(".gitignore", `${AUTHOR_GITIGNORE}memo.txt\n`);
    const calls: string[][] = [];

    expect(await rescueEditorGitignore(copy, [copy], fakeGit(calls))).toBe("foreign");
    expect(calls.map((args) => args[0])).not.toContain("checkout");
    expect(await read(".gitignore")).toContain("memo.txt");
  });

  test("作者の作品では何もしない（git も呼ばない）", async () => {
    await put(".gitignore", `${AUTHOR_GITIGNORE}.aiwriter/cache/\n`);
    await put(".aiwriter/editing.json", "{}");
    await put(".aiwriter/editor-share-manifest.json", "{}");
    const calls: string[][] = [];

    expect(await rescueEditorGitignore(copy, [copy], fakeGit(calls))).toBe("none");
    expect(calls).toEqual([]);
  });
});
