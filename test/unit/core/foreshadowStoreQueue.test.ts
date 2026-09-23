import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 台帳への書き込みを、作品ごとに1件ずつ行う（設計書6.35.1）。
 *
 * ## 何が起きていたか
 *
 * `addForeshadow` は「読む → 採番する → 書く」の3手で動く。提案パネルの
 * 「登録」を続けて押すと、webview のメッセージ処理は**並行に走る**ので、
 * 2件目が1件目の書き込みを待たずに `loadAll` を通る。すると
 *
 *   1件目：読んだ台帳は0件 → `foreshadow_001` を採番
 *   2件目：読んだ台帳も0件 → **同じ `foreshadow_001`** を採番
 *
 * となり、**同じidの伏線が2件できる**（ファイル名も同じなので、あとから
 * 書いたほうが先のものを取り合う）。回収済みにする操作も同じ形で壊れる。
 *
 * ## 確かめ方
 *
 * `SettingsStore` を差し替えて、「読む」に間を作る。直列化されていなければ
 * 2件目の読みが1件目の書き込みを追い越し、idが重なる。
 */

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    window: {
      createOutputChannel: () => ({ appendLine: noop, show: noop, dispose: noop }),
    },
    workspace: {
      getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }),
      fs: { readFile: vi.fn(), writeFile: vi.fn(), createDirectory: vi.fn() },
    },
    Uri: { file: (p: string) => ({ fsPath: p }) },
    EventEmitter: class {
      event = () => ({ dispose: noop });
      fire = noop;
    },
  };
});

/** 台帳の中身（この作り物のストアが持つ唯一の状態） */
let stored: Array<Record<string, unknown>> = [];
/** `loadAll` を何回通ったか。追い越しが起きたかの手がかりにする */
let loadCalls = 0;

vi.mock("../../src/core/settingsStore", () => ({
  SettingsStore: class {
    async loadAll(): Promise<{ records: unknown[]; errors: unknown[] }> {
      loadCalls++;
      /*
        **読み始めた時点の中身を返す。** 本物は一覧を取ってから1件ずつ
        読むので、読んでいる最中に増えたものは入らない。ここを
        「待ち終わってから写す」形にすると、待っている間に書かれた分まで
        見えてしまい、**直列化していなくても辻褄が合ってしまう**
        （実際、最初はそう書いてしまって再現しなかった）。
      */
      const snapshot = [...stored];
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { records: snapshot, errors: [] };
    }
    async saveAll(records: Array<Record<string, unknown>>): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 5));
      for (const record of records) {
        const at = stored.findIndex((entry) => entry.id === record.id);
        if (at >= 0) stored[at] = record;
        else stored.push(record);
      }
    }
  },
}));

import {
  addForeshadow,
  saveOrUpdateForeshadow,
} from "../../src/core/foreshadowStore";
import type { WorkEntry } from "../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
  registeredAt: "2026-08-29T00:00:00.000Z",
};

const other: WorkEntry = { ...work, id: "w2", folderPath: "C:/小説/別の作品" };

beforeEach(() => {
  stored = [];
  loadCalls = 0;
});

describe("同時に登録しても、idが重ならない", () => {
  /** **これが不具合そのもの。** 提案パネルで「登録」を連打すると起きる */
  test("2件を同時に足すと、別々のidが付く", async () => {
    const [first, second] = await Promise.all([
      addForeshadow(work, { label: "銀の懐中時計", source: "ai" }),
      addForeshadow(work, { label: "錠前", source: "ai" }),
    ]);

    expect(first.id).not.toBe(second.id);
    expect(new Set(stored.map((entry) => entry.id)).size).toBe(2);
  });

  test("何件並んでも、順に採番される", async () => {
    const labels = ["一", "二", "三", "四", "五"];
    const saved = await Promise.all(
      labels.map((label) => addForeshadow(work, { label, source: "ai" }))
    );

    expect(saved.map((record) => record.id)).toEqual([
      "foreshadow_001",
      "foreshadow_002",
      "foreshadow_003",
      "foreshadow_004",
      "foreshadow_005",
    ]);
  });

  /**
   * **前の失敗で列を止めない。** 1件が保存できなかっただけで、以降の
   * 「登録」が永久に効かなくなるのが、いちばん困る形である。
   */
  test("1件が失敗しても、次の登録は通る", async () => {
    const failing = saveOrUpdateForeshadow(work, "foreshadow_999", {
      status: "resolved",
    });

    await expect(failing).rejects.toThrow();
    const after = await addForeshadow(work, { label: "錠前", source: "author" });

    expect(after.id).toBe("foreshadow_001");
  });

  /** 別の作品どうしは待ち合わせない（無関係なので遅くする理由が無い） */
  test("別の作品は、それぞれの列で進む", async () => {
    const [a, b] = await Promise.all([
      addForeshadow(work, { label: "銀の懐中時計", source: "ai" }),
      addForeshadow(other, { label: "錠前", source: "ai" }),
    ]);

    // 台帳は作り物なので1つを共有している。**どちらも001から始まる**
    // （実際は作品ごとに別のフォルダー）。ここで見たいのは
    // 「待ち合わせずに両方が読みへ入った」ことである
    expect(loadCalls).toBe(2);
    expect(a.label).toBe("銀の懐中時計");
    expect(b.label).toBe("錠前");
  });
});
