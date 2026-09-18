import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 「古い指摘を片づける」の操作そのもの（設計書6.96.4）。
 *
 * **消す前に、何件消えるかを見せて確認を取る。** `.aiwriter/` は同期される
 * ので、消したことも同期される——消してから件数を告げても取り返せない。
 *
 * 消す・消さないの線引きは `findingPrune.test.ts` が見る。ここで見るのは
 * **訊く順序**である。
 */

/** 偽のディスク */
const files = new Map<string, Uint8Array>();
/** 作者に見せた確認。返す答えは試験ごとに差し替える */
const asked: string[] = [];
let answer: string | undefined;
const told: string[] = [];

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    window: {
      showWarningMessage: vi.fn(async (message: string) => {
        asked.push(message);
        return answer;
      }),
      showInformationMessage: vi.fn(async (message: string) => {
        told.push(message);
        return undefined;
      }),
      showErrorMessage: vi.fn(async (message: string) => {
        told.push(message);
        return undefined;
      }),
      createOutputChannel: () => ({
        appendLine: noop,
        show: noop,
        dispose: noop,
      }),
    },
    workspace: {
      getConfiguration: () => ({
        get: (_key: string, fallback?: unknown) => fallback,
      }),
      fs: {
        readFile: vi.fn(async (uri: { fsPath: string }) => {
          const bytes = files.get(uri.fsPath);
          if (!bytes) throw new Error("FileNotFound");
          return bytes;
        }),
        writeFile: vi.fn(async (uri: { fsPath: string }, bytes: Uint8Array) => {
          files.set(uri.fsPath, bytes);
        }),
        createDirectory: vi.fn(async () => undefined),
      },
    },
    Uri: { file: (p: string) => ({ fsPath: p }) },
    EventEmitter: class {
      event = () => ({ dispose: noop });
      fire = noop;
    },
    ThemeIcon: class {},
    ThemeColor: class {},
    MarkdownString: class {},
    Range: class {},
    Position: class {},
    ViewColumn: { One: 1 },
  };
});

import { pruneFindings } from "../../src/features/pruneFindings";
import { FindingStore } from "../../src/features/findingStore";
import type { Finding } from "../../src/models/finding";
import type { WorkEntry } from "../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
  registeredAt: "2026-09-19T00:00:00.000Z",
};

const daysAgo = (days: number): string =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

function finding(id: string, time: string): Finding {
  return {
    id,
    time,
    file: "本文/001.txt",
    hintLine: 3,
    original: "　彼女は振り返らなかった。",
    target: "振り返らなかった",
    suggestion: "振りかえらなかった",
    before: "",
    after: "",
    message: "送り仮名",
    category: "typo",
    label: "誤字脱字",
  };
}

beforeEach(() => {
  files.clear();
  asked.length = 0;
  told.length = 0;
  answer = undefined;
});

describe("古い指摘を片づける（操作）", () => {
  test("消す前に件数を見せて、確認を取る", async () => {
    await new FindingStore(work).record([
      finding("old1", daysAgo(9)),
      finding("old2", daysAgo(8)),
      finding("new", daysAgo(1)),
    ]);
    answer = "消す";

    await pruneFindings(work);

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("2件");
    expect(await new FindingStore(work).load()).toHaveLength(1);
  });

  test("断られたら、1件も消さない", async () => {
    await new FindingStore(work).record([finding("old1", daysAgo(9))]);
    answer = undefined;

    await pruneFindings(work);

    expect(asked).toHaveLength(1);
    expect(await new FindingStore(work).load()).toHaveLength(1);
  });

  test("消すものが無ければ、確認を出さずに知らせるだけ", async () => {
    await new FindingStore(work).record([finding("new", daysAgo(1))]);

    await pruneFindings(work);

    expect(asked).toEqual([]);
    expect(told.join("")).toContain("ありません");
  });

  test("置き場がまだ無くても、静かに済ませる", async () => {
    await pruneFindings(work);

    expect(asked).toEqual([]);
    expect(told.join("")).toContain("ありません");
  });
});
