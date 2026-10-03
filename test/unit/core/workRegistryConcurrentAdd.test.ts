import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { window, workspace } from "../support/vscodeStub";
import { WorkRegistry } from "../../../src/core/workRegistry";
import { EchoingMemento } from "../support/echoingMemento";

/**
 * 同じフォルダーの登録を、ほぼ同時に2回呼んでも1件しか入らない（2026-10-04）。
 *
 * ノートPCの実機確認（画面の外で起こした VS Code 1.138）で、拡張機能が
 * 起きたあと `novelai.addWork` を同じフォルダーに50ミリ秒の間隔で2回呼ぶと、
 * **登録簿に同じ作品が2件**入った（時刻の差は4ミリ秒）。
 *
 * `addExisting` は「入っているか確かめる」→（設定ファイルと `.gitignore` の
 * 読み書きを待つ）→「足す」の順で、待っているあいだにもう1回が同じ確かめを
 * 通り抜けていた。足す変更（`appendEntry`）は id でしか重なりを見ておらず、
 * 2回目は別の id なので素通りした。
 */

const KEY = "novelai.works";

let root: string;
let warnings: string[];
const originalWarn = window.showWarningMessage;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "novelai-registry-twice-"));
  // 設定ファイルの無い作品フォルダー（登録が設定ファイルを作るので、
  // 読み書きを待つ時間がいちばん長い形）。`.gitignore` の整備はこの試験の
  // 関心ではないので、空のものを置いて素直に通す
  await mkdir(path.join(root, "本文"));
  await writeFile(path.join(root, ".gitignore"), "");
  warnings = [];
  window.showWarningMessage = (async (message: string) => {
    warnings.push(message);
    return undefined;
  }) as typeof window.showWarningMessage;
  // 本物のファイルを読み書きする（待ちが本物の I/O になる）
  workspace.fs = {
    readFile: async (uri: { fsPath: string }) => new Uint8Array(await readFile(uri.fsPath)),
    createDirectory: async (uri: { fsPath: string }) => {
      await mkdir(uri.fsPath, { recursive: true });
    },
    writeFile: async (uri: { fsPath: string }, content: Uint8Array) => {
      await mkdir(path.dirname(uri.fsPath), { recursive: true });
      await writeFile(uri.fsPath, content);
    },
  };
});

afterEach(async () => {
  window.showWarningMessage = originalWarn;
  await rm(root, { recursive: true, force: true });
});

function registryOn(memento: EchoingMemento): WorkRegistry {
  return new WorkRegistry({ globalState: memento } as never, { lateCheckDelays: [] });
}

describe("同じフォルダーの登録を2回ほぼ同時に呼ぶ", () => {
  test("addExisting を2回：登録簿は1件、2回目は「すでに登録されています」で断る", async () => {
    const memento = new EchoingMemento();
    const registry = registryOn(memento);

    const [first, second] = await Promise.all([
      registry.addExisting(root, "二度押しの作品"),
      registry.addExisting(root, "二度押しの作品"),
    ]);

    expect(registry.list()).toHaveLength(1);
    expect(memento.persisted[KEY]).toHaveLength(1);
    // 1回目だけが登録した作品を返す。2回目は既存の重複と同じ扱い
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    expect(warnings).toEqual([
      "このフォルダは「二度押しの作品」としてすでに登録されています。",
    ]);
  });

  test("1回目の途中（書き込みの最中）に2回目が来ても1件", async () => {
    const memento = new EchoingMemento();
    const registry = registryOn(memento);

    // 1回目の設定ファイルの読みを、外から開けるまで止めておく
    const fs = workspace.fs as { readFile: (uri: { fsPath: string }) => Promise<Uint8Array> };
    const realRead = fs.readFile;
    let open: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (open = resolve));
    let reachedRead: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => (reachedRead = resolve));
    let holdOnce = true;
    fs.readFile = async (uri) => {
      if (holdOnce) {
        holdOnce = false;
        reachedRead();
        await held;
      }
      return realRead(uri);
    };

    const first = registry.addExisting(root, "二度押しの作品");
    // 1回目が設定ファイルの読み書きを待っているあいだに押し直す
    await reached;
    const second = registry.addExisting(root, "二度押しの作品");
    // 2回目が先へ進めるだけ進ませてから、1回目を再開する
    await new Promise((resolve) => setTimeout(resolve, 20));
    open();

    expect(await first).toBeDefined();
    expect(await second).toBeUndefined();
    expect(registry.list()).toHaveLength(1);
  });

  test("add と addExisting が重なっても1件", async () => {
    const memento = new EchoingMemento();
    const registry = registryOn(memento);

    const results = await Promise.all([
      registry.addExisting(root, "二度押しの作品"),
      registry.add(root, "二度押しの作品"),
    ]);

    expect(results.filter((r) => r !== undefined)).toHaveLength(1);
    expect(registry.list()).toHaveLength(1);
  });

  test("表記が違う同じフォルダー（末尾の区切り）でも1件", async () => {
    const memento = new EchoingMemento();
    const registry = registryOn(memento);

    await Promise.all([
      registry.addExisting(root, "二度押しの作品"),
      registry.addExisting(`${root}${path.sep}`, "二度押しの作品"),
    ]);

    expect(registry.list()).toHaveLength(1);
  });

  test("別々のフォルダーなら、同時でも両方入る（直列にしても取りこぼさない）", async () => {
    const other = await mkdtemp(path.join(os.tmpdir(), "novelai-registry-other-"));
    try {
      const memento = new EchoingMemento();
      const registry = registryOn(memento);

      const [a, b] = await Promise.all([
        registry.addExisting(root, "一つ目"),
        registry.addExisting(other, "二つ目"),
      ]);

      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(registry.list().map((w) => w.title).sort()).toEqual(["一つ目", "二つ目"]);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  test("別の窓が同じフォルダーを先に登録したら、こちらは断り、見張りも足し戻さない", async () => {
    const memento = new EchoingMemento();
    let openLate: () => void = () => undefined;
    const late = new Promise<void>((resolve) => (openLate = resolve));
    const registry = new WorkRegistry({ globalState: memento } as never, {
      lateCheckDelays: [100],
      wait: () => late,
    });

    // こちらの登録が設定ファイルを読んでいるあいだに、別の窓が同じフォルダーを登録する
    const fs = workspace.fs as { readFile: (uri: { fsPath: string }) => Promise<Uint8Array> };
    const realRead = fs.readFile;
    let once = true;
    fs.readFile = async (uri) => {
      if (once) {
        once = false;
        await memento.update(KEY, [
          {
            id: "w_other_window",
            title: "別の窓の登録",
            folderPath: root,
            registeredAt: "2026-10-04T00:00:00.000Z",
          },
        ]);
      }
      return realRead(uri);
    };

    const added = await registry.addExisting(root, "二度押しの作品");

    expect(added).toBeUndefined();
    expect(registry.list().map((w) => w.id)).toEqual(["w_other_window"]);
    expect(warnings).toEqual([
      "このフォルダは「別の窓の登録」としてすでに登録されています。",
    ]);

    // 作者が別の窓の登録を外したあと、見張りが断った登録を足さない
    await registry.remove("w_other_window");
    openLate();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registry.list()).toEqual([]);
  });

  test("1回目が失敗しても、次の登録は止まらない（順番待ちが詰まらない）", async () => {
    const memento = new EchoingMemento();
    const registry = registryOn(memento);
    const fs = workspace.fs as { writeFile: unknown };
    const realWrite = fs.writeFile;
    let failOnce = true;
    fs.writeFile = async (uri: { fsPath: string }, content: Uint8Array) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("書けなかった（試験）");
      }
      return (realWrite as (u: { fsPath: string }, c: Uint8Array) => Promise<void>)(uri, content);
    };

    const failed = registry.addExisting(root, "二度押しの作品");
    const retried = registry.addExisting(root, "二度押しの作品");

    await expect(failed).rejects.toThrow("書けなかった");
    expect(await retried).toBeDefined();
    expect(registry.list()).toHaveLength(1);
  });
});
