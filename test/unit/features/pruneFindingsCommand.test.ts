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
/** 確認の窓の2行目（内訳）。すべての作品をまとめて消すときに出る */
const askedDetail: (string | undefined)[] = [];
let answer: string | undefined;
const told: string[] = [];
/** 作品を選ぶ窓に並んだもの。選ぶ答えは試験ごとに差し替える */
let picked: ((items: { label: string; description?: string }[]) => unknown) | undefined;
const shownPicks: { label: string; description?: string }[][] = [];

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    window: {
      showWarningMessage: vi.fn(
        async (message: string, options?: { detail?: string } | string) => {
          asked.push(message);
          askedDetail.push(typeof options === "object" ? options.detail : undefined);
          return answer;
        }
      ),
      showQuickPick: vi.fn(async (items: { label: string; description?: string }[]) => {
        shownPicks.push(items);
        return picked ? picked(items) : undefined;
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

import {
  chooseFindingsTarget,
  pruneFindings,
  pruneFindingsAcrossWorks,
} from "../../../src/features/pruneFindings";
import { FindingStore } from "../../../src/features/findingStore";
import type { Finding } from "../../../src/models/finding";
import type { WorkEntry } from "../../../src/models/types";

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
  askedDetail.length = 0;
  told.length = 0;
  answer = undefined;
  picked = undefined;
  shownPicks.length = 0;
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

/*
  **すべての作品を選べる**（作者の依頼、2026-09-23「古い指摘を片づけるですが、
  全作品を選択できるようにしてください」）。作品ごとに押すと、作品の数だけ
  同じ確認を読むことになる。
*/
const work2: WorkEntry = {
  id: "w2",
  title: "教科書チート",
  folderPath: "C:/小説/教科書チート",
  registeredAt: "2026-09-19T00:00:00.000Z",
};
const work3: WorkEntry = {
  id: "w3",
  title: "ハイエルフ未亡人",
  folderPath: "C:/小説/ハイエルフ未亡人",
  registeredAt: "2026-09-19T00:00:00.000Z",
};

describe("古い指摘を片づける：作品を選ぶ窓", () => {
  test("先頭に「すべての作品」があり、合計の件数が出る", async () => {
    await new FindingStore(work).record([finding("a", daysAgo(9)), finding("b", daysAgo(8))]);
    await new FindingStore(work2).record([finding("c", daysAgo(9))]);

    await chooseFindingsTarget([work, work2]);

    const items = shownPicks[0];
    expect(items[0].label).toContain("すべての作品");
    expect(items[0].description).toContain("計3件");
    expect(items[0].description).toContain("2作品");
  });

  test("作品ごとに件数を添え、多い順に並べる", async () => {
    await new FindingStore(work).record([finding("a", daysAgo(9))]);
    await new FindingStore(work2).record([
      finding("b", daysAgo(9)),
      finding("c", daysAgo(8)),
      finding("d", daysAgo(7)),
    ]);

    await chooseFindingsTarget([work, work2]);

    const perWork = shownPicks[0].slice(1, 3);
    expect(perWork[0].label).toBe("教科書チート");
    expect(perWork[0].description).toBe("古い指摘 3件");
    expect(perWork[1].label).toBe("いじめられっ子");
    expect(perWork[1].description).toBe("古い指摘 1件");
  });

  test("取りやめるが最後にある（出口の無い窓にしない）", async () => {
    await chooseFindingsTarget([work, work2]);
    const items = shownPicks[0];
    expect(items[items.length - 1].label).toContain("取りやめる");
  });

  test("「すべての作品」を選ぶと all を返す／作品を選ぶとその作品を返す", async () => {
    picked = (items) => items[0];
    expect(await chooseFindingsTarget([work, work2])).toBe("all");

    picked = (items) => items.find((item) => item.label === "教科書チート");
    expect(await chooseFindingsTarget([work, work2])).toEqual(work2);
  });

  test("取りやめると何も返さない", async () => {
    picked = (items) => items[items.length - 1];
    expect(await chooseFindingsTarget([work, work2])).toBeUndefined();
  });
});

describe("古い指摘を片づける：すべての作品をまとめて", () => {
  test("確認は1回だけ。合計と内訳を1枚で見せる", async () => {
    await new FindingStore(work).record([finding("a", daysAgo(9)), finding("b", daysAgo(8))]);
    await new FindingStore(work2).record([finding("c", daysAgo(9))]);
    answer = "消す";

    await pruneFindingsAcrossWorks([work, work2]);

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("計3件");
    expect(asked[0]).toContain("2作品");
    // **どの作品の指摘が消えるかを、押す前に読める**
    expect(askedDetail[0]).toContain("いじめられっ子　2件");
    expect(askedDetail[0]).toContain("教科書チート　1件");
  });

  test("消すと、どの作品からも古い指摘だけが消える（新しいものは残る）", async () => {
    await new FindingStore(work).record([finding("old", daysAgo(9)), finding("new", daysAgo(1))]);
    await new FindingStore(work2).record([finding("old2", daysAgo(9))]);
    answer = "消す";

    await pruneFindingsAcrossWorks([work, work2]);

    expect((await new FindingStore(work).load()).map((f) => f.id)).toEqual(["new"]);
    expect(await new FindingStore(work2).load()).toHaveLength(0);
    expect(told.join("")).toContain("計2件");
  });

  test("断られたら、どの作品からも1件も消さない", async () => {
    await new FindingStore(work).record([finding("old", daysAgo(9))]);
    await new FindingStore(work2).record([finding("old2", daysAgo(9))]);
    answer = undefined;

    await pruneFindingsAcrossWorks([work, work2]);

    expect(await new FindingStore(work).load()).toHaveLength(1);
    expect(await new FindingStore(work2).load()).toHaveLength(1);
  });

  test("古い指摘の無い作品は、内訳にも数にも入れない", async () => {
    await new FindingStore(work).record([finding("old", daysAgo(9))]);
    await new FindingStore(work3).record([finding("new", daysAgo(1))]);
    answer = "消す";

    await pruneFindingsAcrossWorks([work, work3]);

    expect(asked[0]).toContain("1作品");
    expect(askedDetail[0]).not.toContain("ハイエルフ未亡人");
  });

  test("どの作品にも無ければ、確認を出さずに知らせるだけ", async () => {
    await new FindingStore(work).record([finding("new", daysAgo(1))]);

    await pruneFindingsAcrossWorks([work, work2]);

    expect(asked).toEqual([]);
    expect(told.join("")).toContain("どの作品にも");
  });
});
