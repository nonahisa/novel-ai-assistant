import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { workspace } from "../support/vscodeStub";
import { WorkRegistry } from "../../../src/core/workRegistry";
import { MementoWriteLostError } from "../../../src/core/verifiedMemento";
import type { WorkEntry } from "../../../src/models/types";
import { EchoingMemento, tick } from "../support/echoingMemento";

/**
 * 登録した直後に登録簿から消える（2026-10-03。0.97.3）。
 *
 * 画面の自動テストで、拡張機能が起きた直後に作品を登録すると、4回に1回ほど
 * 「登録しました」と出たのに登録簿（globalState）から消えていた。
 *
 * 原因は VS Code の globalState の作り（`support/echoingMemento.ts` の説明）。
 * 起動のときに書いた別の鍵（「はじめまして」の印など）の**送り返しが、
 * 登録簿を書いたあとに届き**、手元の塊が古い塊で丸ごと差し替わって、
 * 登録簿の無い塊が保存される。
 */

const KEY = "novelai.works";

function contextOf(memento: EchoingMemento) {
  return { globalState: memento } as never;
}

function entry(id: string, title: string, folderPath: string): WorkEntry {
  return { id, title, folderPath, registeredAt: "2026-10-03T00:00:00.000Z" };
}

/** 外から開け閉めできる待ち（遅れて消える形を、決まった順で起こす） */
function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { wait: () => opened, open };
}

describe("起動のときの書き込みと重なっても、登録は消えない", () => {
  test("先の書き込みの送り返しが、登録の書き込みと送出のあいだに届く", async () => {
    const memento = new EchoingMemento();
    const registry = new WorkRegistry(contextOf(memento), { lateCheckDelays: [] });

    // 起動のとき：「はじめまして」の印を書く（待たずに投げる）。
    // 送出は済んだが、送り返しはまだ届いていない
    memento.holdEchoes = true;
    void memento.update("novelai.firstRun.shown", true);
    await tick();
    memento.holdEchoes = false;

    const added = await registry.add("C:\\novels\\新作", "新作");

    expect(added).toBeDefined();
    // 手元でも、本体に保存された塊でも、登録が残っている
    expect(registry.list().map((w) => w.title)).toEqual(["新作"]);
    expect(memento.persisted[KEY]).toEqual([added]);
    // 起動のときの印も消していない
    expect(memento.persisted["novelai.firstRun.shown"]).toBe(true);
  });

  test("読み返したときは在ったのに、あとから古い塊が届いて消えても、当て直す", async () => {
    const memento = new EchoingMemento();
    const late = gate();
    const registry = new WorkRegistry(contextOf(memento), {
      lateCheckDelays: [100],
      wait: late.wait,
    });

    memento.holdEchoes = true;
    void memento.update("novelai.firstRun.shown", true);
    await tick();

    const added = await registry.add("C:\\novels\\新作", "新作");
    expect(registry.list()).toHaveLength(1);

    // 古い塊（登録簿が無い）が、新しい塊より後に届く
    memento.holdEchoes = false;
    memento.deliverHeldEchoes("newest-first");
    expect(registry.list()).toHaveLength(0);

    late.open();
    await tick();
    await tick();
    await tick();

    expect(registry.list().map((w) => w.id)).toEqual([added?.id]);
    expect(memento.persisted[KEY]).toEqual([added]);
  });

  test("あとから外した作品を、見張りが足し戻さない", async () => {
    const memento = new EchoingMemento();
    const late = gate();
    const registry = new WorkRegistry(contextOf(memento), {
      lateCheckDelays: [100],
      wait: late.wait,
    });

    const added = await registry.add("C:\\novels\\新作", "新作");
    await registry.remove(added!.id);

    late.open();
    await tick();
    await tick();

    expect(registry.list()).toHaveLength(0);
    expect(memento.persisted[KEY]).toEqual([]);
  });

  test("何度書いても残らなければ、黙らずに失敗を返す", async () => {
    const memento = new EchoingMemento();
    const registry = new WorkRegistry(contextOf(memento), { lateCheckDelays: [] });
    memento.sabotage = { "novelai.firstRun.shown": true };

    await expect(registry.add("C:\\novels\\新作", "新作")).rejects.toBeInstanceOf(
      MementoWriteLostError
    );
  });
});

describe("登録の途中で、ほかの書き込みが入っても古い写しで書き戻さない", () => {
  test("既存フォルダーの登録（読み書きを待つ間）に、別の作品の登録解除が入る", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "novelai-registry-echo-"));
    try {
      await mkdir(path.join(root, ".aiwriter"));
      await writeFile(
        path.join(root, ".aiwriter", "config.json"),
        JSON.stringify({
          schemaVersion: "1",
          workTitle: "既存作",
          manuscriptDir: "本文",
          settingsDir: "設定",
          createdAt: "2026-10-03T00:00:00.000Z",
        })
      );
      await writeFile(path.join(root, ".gitignore"), "");
      const { readFile } = await import("node:fs/promises");
      workspace.fs = {
        readFile: async (uri: { fsPath: string }) =>
          new Uint8Array(await readFile(uri.fsPath)),
      };

      const memento = new EchoingMemento();
      const old = entry("w_old", "消す作品", "C:\\novels\\消す");
      await memento.update(KEY, [old]);
      const registry = new WorkRegistry(contextOf(memento), { lateCheckDelays: [] });

      const adding = registry.addExisting(root, "既存作");
      await registry.remove("w_old");
      const added = await adding;

      // 外した作品が、登録の書き込みで生き返らない
      expect(registry.list().map((w) => w.id)).toEqual([added!.id]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
