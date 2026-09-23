import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 回収予定の話を書く口と、ほかの口が回収予定を消さないこと（設計書6.35）。
 *
 * **作者だけが書く項目である**（`authorNotes` と同じ扱い）。AIの回収確認は
 * `saveOrUpdateForeshadow` を通るので、そこで予定が消えると、作者が決めた
 * ことがAIの1回の確認で黙って失われる。
 *
 * `SettingsStore` を差し替えて、台帳の中身だけを持つ作り物で確かめる
 * （`foreshadowStoreQueue.test.ts` と同じ作り）。
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

let stored: Array<Record<string, unknown>> = [];

vi.mock("../../../src/core/settingsStore", () => ({
  SettingsStore: class {
    async loadAll(): Promise<{ records: unknown[]; errors: unknown[] }> {
      return { records: stored.map((record) => ({ ...record })), errors: [] };
    }
    async saveAll(records: Array<Record<string, unknown>>): Promise<void> {
      for (const record of records) {
        const at = stored.findIndex((entry) => entry.id === record.id);
        if (at >= 0) stored[at] = record;
        else stored.push(record);
      }
    }
  },
}));

import {
  saveOrUpdateForeshadow,
  setForeshadowPlannedResolve,
} from "../../../src/core/foreshadowStore";
import { emptyForeshadow } from "../../../src/models/foreshadow";
import type { WorkEntry } from "../../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "試験の作品",
  folderPath: "/works/w1",
} as WorkEntry;

beforeEach(() => {
  stored = [
    {
      ...emptyForeshadow("foreshadow_001", "銀の懐中時計"),
      plantedChapter: 3,
      authorNotes: "作者のメモ",
    },
  ];
});

describe("回収予定の話を決める", () => {
  test("話数を書く。ほかの項目には触らない", async () => {
    const saved = await setForeshadowPlannedResolve(work, "foreshadow_001", 12);
    expect(saved.plannedResolveChapter).toBe(12);
    expect(stored[0].plannedResolveChapter).toBe(12);
    expect(stored[0].authorNotes).toBe("作者のメモ");
    expect(stored[0].plantedChapter).toBe(3);
    expect(stored[0].status).toBe("open");
  });

  test("null で未定に戻せる", async () => {
    stored[0].plannedResolveChapter = 12;
    await setForeshadowPlannedResolve(work, "foreshadow_001", null);
    expect(stored[0].plannedResolveChapter).toBeNull();
  });

  test("無い伏線は作り直さずに止める", async () => {
    await expect(
      setForeshadowPlannedResolve(work, "foreshadow_999", 3)
    ).rejects.toThrow(/見つかりません/);
    expect(stored).toHaveLength(1);
  });
});

describe("状態を変えても、回収予定は消えない", () => {
  test("回収済みにしても（AIの回収確認と同じ口）予定は残る", async () => {
    stored[0].plannedResolveChapter = 12;
    await saveOrUpdateForeshadow(work, "foreshadow_001", {
      status: "resolved",
      resolvedChapter: 11,
      resolvedQuote: "",
    });
    expect(stored[0].plannedResolveChapter).toBe(12);
    expect(stored[0].status).toBe("resolved");
  });
});
