import { mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { atomicWriteFile, setOneStepReplaceForTests } from "../../../src/core/atomicWrite";
import { FileSystemError, workspace } from "../support/vscodeStub";

/**
 * 置き換えの最中に、ほかの読み手がファイルを「無い」と見ないか（本物のディスク）。
 *
 * **なぜ要るのか**（2026-11-14、遅いノートPCの画面テスト2件）。投稿の記録
 * （`投稿状態.json`）を製品が書き戻している最中に読んだテストが ENOENT で落ちた。
 * `atomicWriteFile` の指定なしは `vscode.workspace.fs.rename(..., { overwrite: true })`
 * で置き換えていたが、VS Code 本体の上書きの移動（`FileService.doMoveCopy`）は
 * **保存先を消してから名前を変える**2手である（1.90 と 1.145 の束で確かめた）。
 * 2手の間は、同期・相談・MCP・投稿の記録など、どの読み手から見ても保存先が無い。
 *
 * 試験では `workspace.fs.rename` を本体と同じ2手で写し、`writeFile`・`readFile` を
 * 本物のディスクへつなぐ。
 *
 * **読み手はフォルダーの一覧（`readdir`）で「名前が載っているか」を見る。** ファイルを
 * 開くと Windows が置き換えを断り、製品が今までの道へ譲るかどうかが読み手の間隔と
 * 機械の混み具合で揺れる（全件の走りで1回落ちた）。一覧は開かないので揺れない。
 * あわせて「書いた中身が最後に届いているか」も見る（片方だけだと「読めるが書けない」作りが通る）。
 */

let dir = "";
/** 本体の移動を写した `rename` が呼ばれた回数と、消したあとに保存先が無かった回数 */
let vscodeRenames = 0;
let missingBetweenSteps = 0;

/** VS Code 本体の上書きの移動を写したもの。保存先を消す → 一拍おく → 名前を変える */
function useVscodeLikeFs(): void {
  const fsPathOf = (uri: { fsPath: string }) => uri.fsPath;
  const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
  workspace.fs = {
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
      await writeFile(fsPathOf(uri), bytes);
    },
    readFile: async (uri: { fsPath: string }) => {
      try {
        return new Uint8Array(await readFile(fsPathOf(uri)));
      } catch (error) {
        if (missing(error)) throw new FileSystemError("missing", "FileNotFound");
        throw error;
      }
    },
    rename: async (from: { fsPath: string }, to: { fsPath: string }, options?: { overwrite?: boolean }) => {
      vscodeRenames += 1;
      const exists = await stat(fsPathOf(to)).then(() => true, () => false);
      if (exists && !options?.overwrite) throw new FileSystemError("exists", "FileExists");
      if (exists) {
        await unlink(fsPathOf(to));
        // 本体はこの間に親フォルダーを確かめ（mkdirp）、別の IPC で名前を変える。
        // その間に読み手が来たら何が見えるかを、ここで1回確かめる
        if (!(await readdir(dirname(fsPathOf(to)))).includes(basename(fsPathOf(to)))) {
          missingBetweenSteps += 1;
        }
      }
      await rename(fsPathOf(from), fsPathOf(to));
    },
    delete: async (uri: { fsPath: string }) => {
      await unlink(fsPathOf(uri));
    },
  };
}

/** 書いている間じゅうフォルダーの一覧を見続け、保存先の名前が載っていなかった回数を数える */
async function writeWhileListing(target: string, writes: number): Promise<{ missing: number; looks: number }> {
  let stop = false;
  let missing = 0;
  let looks = 0;
  const watcher = (async () => {
    while (!stop) {
      if (!(await readdir(dirname(target))).includes(basename(target))) missing += 1;
      looks += 1;
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  try {
    for (let index = 0; index < writes; index += 1) {
      await atomicWriteFile(target, new TextEncoder().encode(`{"n":${index}}\n`));
    }
  } finally {
    stop = true;
    await watcher;
  }
  return { missing, looks };
}

describe("置き換えの最中の読み手（本物のディスク）", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomW_"));
    vscodeRenames = 0;
    missingBetweenSteps = 0;
    useVscodeLikeFs();
  });

  afterEach(async () => {
    setOneStepReplaceForTests(false);
    await rm(dir, { recursive: true, force: true });
  });

  test("本体の上書きの移動だけで置き換えると、2手の間は保存先が無い（直す前の形）", async () => {
    const target = join(dir, "投稿状態.json");
    await writeFile(target, "{}\n");
    setOneStepReplaceForTests(false);

    for (let index = 0; index < 5; index += 1) {
      await atomicWriteFile(target, new TextEncoder().encode(`{"n":${index}}\n`));
    }

    expect(vscodeRenames).toBe(5);
    expect(missingBetweenSteps).toBe(5);
  });

  test("手元では1回の名前の変更で置き換え、見ている間に保存先が消えない", async () => {
    const target = join(dir, "投稿状態.json");
    await writeFile(target, "{}\n");
    // 製品の道（Node の rename）へ戻す
    setOneStepReplaceForTests(undefined);

    const result = await writeWhileListing(target, 60);

    expect(result.missing).toBe(0);
    expect(result.looks).toBeGreaterThan(0);
    // 本体の移動（消してから名前を変える道）を一度も通っていない
    expect(vscodeRenames).toBe(0);
    // 書いた中身が最後まで届いている（置き換えを諦めて黙っていない）
    expect(await readFile(target, "utf8")).toBe(`{"n":59}\n`);
    // 一時ファイルが残っていない
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("保存先がまだ無いときも1回の名前の変更で置ける", async () => {
    const target = join(dir, "スケジュール.json");
    setOneStepReplaceForTests(undefined);

    await atomicWriteFile(target, new TextEncoder().encode("{}\n"));

    expect(await readFile(target, "utf8")).toBe("{}\n");
    expect(vscodeRenames).toBe(0);
  });
});
