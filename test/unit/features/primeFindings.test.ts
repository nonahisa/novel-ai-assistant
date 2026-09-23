import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 開き直したときに、残っている指摘を提案パネルへ戻す（設計書6.96.4）。
 *
 * **先例は `primePendingRecordUpdates`**（6.11.6）。同じ作法で、静かに、
 * 作品ごとに読む。ここで見るのは「何が戻って、何が戻らないか」——
 * 捨てる判断を画面側へ写していないことが要である。
 */

const files = new Map<string, Uint8Array>();

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn() },
    window: {
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
      showErrorMessage: vi.fn(),
      createOutputChannel: () => ({
        appendLine: noop,
        show: noop,
        dispose: noop,
      }),
    },
    workspace: {
      getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }),
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

/** いまの本文。読めないファイルを試すため、`undefined` も返せる形にする */
let text: string | undefined;

vi.mock("../../../src/core/textFile", () => ({
  readTextFile: vi.fn(async () => {
    if (text === undefined) throw new Error("FileNotFound");
    return {
      text,
      hash: "h",
      encoding: "utf8",
      eol: "\n",
      hasTrailingNewline: true,
      hasConflictMarkers: false,
      hasMixedEol: false,
    };
  }),
  sameFilePath: () => false,
  writeTextFilePreservingFormat: vi.fn(async () => ({ ok: true })),
}));

import {
  handOverFinding,
  primeSavedFindings,
} from "../../../src/features/primeFindings";
import { FindingStore } from "../../../src/features/findingStore";
import { findingFilePath } from "../../../src/core/findingSource";
import type {
  ContradictionViewItem,
  ProposalPanel,
  ProposalViewItem,
} from "../../../src/features/proposalPanel";
import type { Finding, FindingDecision } from "../../../src/models/finding";
import type { WorkEntry } from "../../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
  registeredAt: "2026-09-19T00:00:00.000Z",
};

/** いま（`isFindingExpired` の起点はここから数える） */
const NOW = new Date();
const daysAgo = (days: number): string =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    time: daysAgo(1),
    file: "本文/001.txt",
    hintLine: 3,
    original: "　彼女は振り返らなかった。",
    target: "振り返らなかった",
    suggestion: "振りかえらなかった",
    before: "　朝の廊下は静かだった。",
    after: "　窓の外で鐘が鳴る。",
    message: "送り仮名が他の箇所と揃っていません",
    category: "typo",
    // **分類名を残す**（設計書6.88.9）。戻し先はこれで決まる
    label: "誤字脱字",
    ...overrides,
  };
}

/** 戻し先の受け皿。**本物のパネルは要らない**——渡した中身だけを見る */
interface Restored {
  category: string;
  items: ProposalViewItem[];
  contradictions: ContradictionViewItem[];
}

function fakePanel(into: Restored[]): ProposalPanel {
  const panel = {
    showRestoredFindings(
      _work: WorkEntry,
      category: string,
      contents: {
        items?: ProposalViewItem[];
        contradictions?: ContradictionViewItem[];
      }
    ): void {
      into.push({
        category,
        items: contents.items ?? [],
        contradictions: contents.contradictions ?? [],
      });
    },
  };
  return panel as unknown as ProposalPanel;
}

async function seed(
  lines: ReadonlyArray<Finding | FindingDecision>
): Promise<void> {
  const store = new FindingStore(work);
  for (const line of lines) {
    if ("findingId" in line) {
      await store.decide([line]);
      continue;
    }
    await store.record([line]);
  }
}

beforeEach(() => {
  files.clear();
  text = [
    "　朝の廊下は静かだった。",
    "",
    "　彼女は振り返らなかった。",
    "",
    "　窓の外で鐘が鳴る。",
  ].join("\n");
});

describe("残っている指摘を戻す", () => {
  test("残っている指摘が、種類ごとの分類へ戻る", async () => {
    await seed([finding()]);
    const restored: Restored[] = [];

    const count = await primeSavedFindings(work, fakePanel(restored));

    expect(count).toBe(1);
    expect(restored).toHaveLength(1);
    expect(restored[0].category).toBe("誤字脱字");
    expect(restored[0].items[0]).toMatchObject({
      id: "f1",
      // **相対で残したものを、いまの手元のありかへ戻す**
      filePath: findingFilePath(work.folderPath, "本文/001.txt"),
      fileName: "001.txt",
      line: 3,
      target: "振り返らなかった",
      suggestion: "振りかえらなかった",
      status: "pending",
    });
  });

  /** 本文が動いていても追随する（6.96.3）。行番号は鍵ではない */
  test("本文が動いていれば、いまの行で戻る", async () => {
    await seed([finding()]);
    text = ["　新しい書き出し。", ""].join("\n") + "\n" + text;
    const restored: Restored[] = [];

    await primeSavedFindings(work, fakePanel(restored));

    expect(restored[0].items[0].line).toBe(5);
  });

  /** **捨てるのは `locateFindings` の仕事**（画面側で書かない） */
  test("本文から消えた指摘は戻らない", async () => {
    await seed([finding()]);
    text = "　まるごと書き直した話。";
    const restored: Restored[] = [];

    expect(await primeSavedFindings(work, fakePanel(restored))).toBe(0);
    expect(restored).toEqual([]);
  });

  /** 既定は3日（`novelai.findings.retentionDays`） */
  test("期限を過ぎた指摘は戻らない（ファイルからは消えない）", async () => {
    await seed([finding({ time: daysAgo(5) })]);
    const restored: Restored[] = [];

    expect(await primeSavedFindings(work, fakePanel(restored))).toBe(0);
    // 隠すだけで、消してはいない
    expect(await new FindingStore(work).load()).toHaveLength(1);
  });

  test("判断の済んだ指摘は戻らない", async () => {
    await seed([
      finding(),
      { findingId: "f1", time: daysAgo(0), status: "dismissed", note: "" },
    ]);
    const restored: Restored[] = [];

    expect(await primeSavedFindings(work, fakePanel(restored))).toBe(0);
  });

  test("本文が読めないファイルの指摘は、戻さないが消しもしない", async () => {
    await seed([finding()]);
    text = undefined;
    const restored: Restored[] = [];

    expect(await primeSavedFindings(work, fakePanel(restored))).toBe(0);
    expect(await new FindingStore(work).load()).toHaveLength(1);
  });

  /**
   * **押しても何も起きない口を作らない。** 照らす相手も、再チェックへ
   * 渡す材料も残していないので、その2つは出さない
   */
  test("矛盾は、相手を開く口と再チェックを出さない形で戻る", async () => {
    await seed([
      finding({
        id: "f2",
        category: "contradiction",
        label: "矛盾",
        target: "",
        suggestion: "",
        message: "設定では：必ず振り返る／本文では：振り返らなかった",
      }),
    ]);
    const restored: Restored[] = [];

    await primeSavedFindings(work, fakePanel(restored));

    expect(restored[0].category).toBe("矛盾");
    const item = restored[0].contradictions[0];
    expect(item).toMatchObject({
      id: "f2",
      line: 3,
      excerpt: "　彼女は振り返らなかった。",
      openTarget: "none",
      allowRecheck: false,
      settingSays: "設定では：必ず振り返る／本文では：振り返らなかった",
      textSays: "",
    });
  });

  test("種類ごとに分けて戻す（誤字脱字と矛盾が同じ段に混ざらない）", async () => {
    await seed([
      finding(),
      finding({
        id: "f2",
        category: "contradiction",
        label: "矛盾",
        target: "",
        suggestion: "",
      }),
    ]);
    const restored: Restored[] = [];

    expect(await primeSavedFindings(work, fakePanel(restored))).toBe(2);
    expect(restored.map((entry) => entry.category).sort()).toEqual([
      "矛盾",
      "誤字脱字",
    ]);
    for (const entry of restored) {
      expect(entry.items.length === 0 || entry.contradictions.length === 0).toBe(
        true
      );
    }
  });

  test("何も残っていなければ、画面へは何も渡さない", async () => {
    const restored: Restored[] = [];
    expect(await primeSavedFindings(work, fakePanel(restored))).toBe(0);
    expect(restored).toEqual([]);
  });
});

/**
 * 分類名を残す（設計書6.88.9）。
 *
 * 「矛盾」と「矛盾（事実の照合）」は、どちらも種類が `contradiction` である。
 * 出どころの種類しか残していなかったころ、**事実の照合で出た指摘が
 * 「矛盾」のタブへ入っていた**——2つを並行させて見比べるという決めと
 * 正面からぶつかる。
 */
describe("戻す先は、記録したときの分類名で決まる", () => {
  test("事実の照合で出た指摘は、事実の照合のタブへ戻る", async () => {
    await seed([
      finding({
        id: "f9",
        category: "contradiction",
        label: "矛盾（事実の照合）",
        target: "",
        suggestion: "",
      }),
    ]);
    const restored: Restored[] = [];

    await primeSavedFindings(work, fakePanel(restored));

    expect(restored[0].category).toBe("矛盾（事実の照合）");
    expect(restored[0].contradictions[0].category).toBe("矛盾（事実の照合）");
  });

  test("同じ分類の指摘でも、2つのタブが混ざらない", async () => {
    await seed([
      finding({
        id: "f10",
        category: "contradiction",
        label: "矛盾",
        target: "",
        suggestion: "",
      }),
      finding({
        id: "f11",
        category: "contradiction",
        label: "矛盾（事実の照合）",
        target: "",
        suggestion: "",
      }),
    ]);
    const restored: Restored[] = [];

    expect(await primeSavedFindings(work, fakePanel(restored))).toBe(2);
    expect(restored.map((entry) => entry.category).sort()).toEqual([
      "矛盾",
      "矛盾（事実の照合）",
    ]);
  });

  test("左右の見出しを残してあれば、そのまま並べて戻る", async () => {
    await seed([
      finding({
        id: "f12",
        category: "deviation",
        label: "プロット逸脱",
        target: "",
        suggestion: "",
        message: "プロットでは：告白する／この話では：黙って帰る",
        compared: {
          leftLabel: "プロットでは",
          left: "告白する",
          rightLabel: "この話では",
          right: "黙って帰る",
          note: "12〜18行",
        },
      }),
    ]);
    const restored: Restored[] = [];

    await primeSavedFindings(work, fakePanel(restored));

    // **「設定では」と決め打ちしない**（逸脱は言葉が違う）
    expect(restored[0].contradictions[0]).toMatchObject({
      leftLabel: "プロットでは",
      settingSays: "告白する",
      rightLabel: "この話では",
      textSays: "黙って帰る",
      note: "12〜18行",
    });
  });

  test("分類名の無い古い記録も、種類から決めて戻す", async () => {
    await seed([
      finding({
        id: "f13",
        category: "contradiction",
        label: "",
        target: "",
        suggestion: "",
      }),
    ]);
    const restored: Restored[] = [];

    expect(await primeSavedFindings(work, fakePanel(restored))).toBe(1);
    expect(restored[0].category).toBe("矛盾");
  });
});

/**
 * シーンメモの「直す」の行き先（設計書6.96.5）。
 *
 * **1件だけを、同じ道で渡す。** 組み立ての写しを置くと、戻し方が片方だけ
 * 直る日が来る。位置は**探し直した行**を使う（保存してある `hintLine` では
 * ない。6.96.3）。
 */
describe("1件だけを提案パネルへ渡す", () => {
  test("探し直した行で渡る（保存してある行ではない）", () => {
    const restored: Restored[] = [];
    const ok = handOverFinding(work, fakePanel(restored), {
      ...finding({ hintLine: 3 }),
      line: 47,
    });

    expect(ok).toBe(true);
    expect(restored[0].category).toBe("誤字脱字");
    expect(restored[0].items[0].line).toBe(47);
  });

  test("矛盾は食い違いの形で渡る", () => {
    const restored: Restored[] = [];
    const ok = handOverFinding(work, fakePanel(restored), {
      ...finding({
        category: "contradiction",
        label: "矛盾",
        target: "",
        suggestion: "",
      }),
      line: 3,
    });

    expect(ok).toBe(true);
    expect(restored[0].contradictions).toHaveLength(1);
    expect(restored[0].items).toEqual([]);
  });

  test("戻し方の決まっていない種類は渡さない", () => {
    const restored: Restored[] = [];
    const ok = handOverFinding(work, fakePanel(restored), {
      ...finding({ category: "other", label: "" }),
      line: 3,
    });

    // **押しても何も起きない口を作らない**——渡せなければ呼んだ側が断る
    expect(ok).toBe(false);
    expect(restored).toEqual([]);
  });
});
