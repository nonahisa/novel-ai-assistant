import { mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
 * 本物のディスクへつなぐ。読み手は回し続け、**ENOENT の数と、書いた中身が最後に
 * 届いているか**の両方を見る（片方だけだと「読めるが書けない」作りが通る）。
 */

let dir = "";

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
      const exists = await stat(fsPathOf(to)).then(() => true, () => false);
      if (exists && !options?.overwrite) throw new FileSystemError("exists", "FileExists");
      if (exists) {
        await unlink(fsPathOf(to));
        // 本体はこの間に親フォルダーを確かめ（mkdirp）、別の IPC で名前を変える
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await rename(fsPathOf(from), fsPathOf(to));
    },
    delete: async (uri: { fsPath: string }) => {
      await unlink(fsPathOf(uri));
    },
  };
}

/** 書いている間じゅう読み続け、読めなかった回数を種類ごとに数える */
async function writeWhileReading(target: string, writes: number, readerCount: number, pauseMs: number): Promise<{
  missing: number;
  otherErrors: string[];
  reads: number;
}> {
  let stop = false;
  let missing = 0;
  let reads = 0;
  const otherErrors: string[] = [];
  const reader = async () => {
    while (!stop) {
      try {
        await readFile(target);
        reads += 1;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? String(error);
        if (code === "ENOENT") missing += 1;
        else otherErrors.push(code);
      }
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  };
  const readers = Array.from({ length: readerCount }, () => reader());
  try {
    for (let index = 0; index < writes; index += 1) {
      await atomicWriteFile(target, new TextEncoder().encode(`{"n":${index}}\n`));
    }
  } finally {
    stop = true;
    await Promise.all(readers);
  }
  return { missing, otherErrors, reads };
}

describe("置き換えの最中の読み手（本物のディスク）", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomW_"));
    useVscodeLikeFs();
  });

  afterEach(async () => {
    setOneStepReplaceForTests(false);
    await rm(dir, { recursive: true, force: true });
  });

  test("本体の上書きの移動だけで置き換えると、読み手が「無い」に当たる（直す前の形）", async () => {
    const target = join(dir, "投稿状態.json");
    await writeFile(target, "{}\n");
    setOneStepReplaceForTests(false);

    // 隙間に当てたいだけなので、読み手は詰めて回す
    const result = await writeWhileReading(target, 60, 2, 2);

    expect(result.missing).toBeGreaterThan(0);
  });

  test("手元では1回の名前の変更で置き換え、読み手は一度も「無い」に当たらない", async () => {
    const target = join(dir, "投稿状態.json");
    await writeFile(target, "{}\n");
    // 製品の道（Node の rename）へ戻す
    setOneStepReplaceForTests(undefined);

    // 読み手は実際に近い間隔で回す（画面テストは100ミリ秒おき、MCP や同期はもっと疎ら）。
    // 開いている間は Windows が置き換えを断るので、詰めすぎると製品は今までの道へ譲る
    // ——探りでは2本が2ミリ秒おきに開くと、500ミリ秒繰り返しても通らない回が60回中2回あった。
    // 譲った回は隙間が出るので、ここでは譲らずに済む間隔にする
    const result = await writeWhileReading(target, 60, 1, 20);

    expect(result.missing).toBe(0);
    expect(result.otherErrors).toEqual([]);
    expect(result.reads).toBeGreaterThan(0);
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
  });
});
