import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 検知が出した指摘を `.aiwriter/findings.jsonl` へ残す配線（設計書6.96）。
 *
 * **土台（置き場・位置の探し直し）は `findingStore.test.ts` と
 * `findingLocation.test.ts` が見る。** ここで見るのは配線のほう——
 * 提案パネルへ渡る道が1本に絞れているか、残してはいけないものが
 * 残っていないか、作者の判断が追記されるか。
 *
 * **記録は指摘の表示を止めない。** 書き込みを待たずに走らせているので、
 * どの検査も1回だけ間（`settle`）を置いてから見る。
 */

/** 手元のファイル（`fsPath` → 中身）。置き場の書き込みもここへ落ちる */
const files = new Map<string, Uint8Array>();

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn() },
    window: {
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
      showErrorMessage: vi.fn(),
      showTextDocument: vi.fn(),
      setStatusBarMessage: vi.fn(() => ({ dispose: noop })),
      visibleTextEditors: [],
      createOutputChannel: () => ({
        appendLine: noop,
        show: noop,
        dispose: noop,
      }),
    },
    workspace: {
      getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }),
      textDocuments: [],
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

/**
 * 本文。**読むほうは本物と同じ道を通したい**ので、内容だけを差し替える
 * （`findingRecorder` も提案パネルも、この `readTextFile` を通る）。
 */
let text = [
  "　朝の廊下は静かだった。",
  "",
  "　彼女は振り返らなかった。",
  "",
  "　窓の外で鐘が鳴る。",
].join("\n");

vi.mock("../../../src/core/textFile", () => ({
  readTextFile: vi.fn(async () => ({
    text,
    hash: "h",
    encoding: "utf8",
    eol: "\n",
    hasTrailingNewline: true,
    hasConflictMarkers: false,
    hasMixedEol: false,
  })),
  sameFilePath: () => false,
  writeTextFilePreservingFormat: vi.fn(async (_path: string, next: string) => {
    text = next;
    return { ok: true };
  }),
}));

vi.mock("../../../src/core/fileLockStore", () => ({
  FileLockStore: class {
    async lockFor(): Promise<undefined> {
      return undefined;
    }
  },
}));

vi.mock("../../../src/core/actorContext", () => ({
  isEditorMode: () => false,
  manualActor: () => "author",
  recordEdit: vi.fn(async () => undefined),
}));

/** 見送りの記録（`typo_dismissed.json`）はここの関心ではない */
vi.mock("../../../src/core/typoIssueHistory", () => ({
  TypoDismissedHistory: class {
    add = () => Promise.resolve(undefined);
    load = () => Promise.resolve(new Set<string>());
  },
  dismissKey: (filePath: string, item: { target: string }) =>
    `${filePath}:${item.target}`,
  appendAiActionLog: () => Promise.resolve(undefined),
}));

import {
  ProposalPanel,
  type ProposalViewItem,
  type RecordUpdateViewItem,
} from "../../../src/features/proposalPanel";
import type { AcceptedContradiction } from "../../../src/core/contradictionValidation";
import type { WorkEntry } from "../../../src/models/types";
import type { FindingLine } from "../../../src/models/finding";

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
  registeredAt: "2026-09-19T00:00:00.000Z",
};

const FILE = "C:/小説/いじめられっ子/本文/001.txt";

/** 誤字脱字の1件（本文の3行目を指す） */
function issue() {
  return {
    filePath: FILE,
    chunkHash: "h1",
    line: 3,
    original: "　彼女は振り返らなかった。",
    target: "振り返らなかった",
    suggestion: "振りかえらなかった",
    reason: "送り仮名",
    confidence: "high" as const,
  };
}

/** 矛盾の1件（同じ行を指す） */
// 返す形を名乗っておく（製品側の項目が増えたら、この作り物で気づける）
function contradiction(): AcceptedContradiction {
  return {
    filePath: FILE,
    chunkHash: "h1",
    line: 3,
    excerpt: "　彼女は振り返らなかった。",
    category: "人物",
    settingSays: "彼女は必ず振り返る",
    textSays: "振り返らなかった",
    note: "",
    severity: "medium" as const,
    confidence: "medium" as const,
  };
}

/**
 * 書き込みを待たずに走らせているので、1回だけ間を置く。
 * **大きな処理の直後に置かない**——押した操作ごとに置いて、
 * どの操作の結果を見ているのかを残す
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 置き場に落ちた行（1行1件） */
function savedLines(): FindingLine[] {
  const entry = [...files].find(([name]) => name.includes("findings.jsonl"));
  if (!entry) return [];
  return new TextDecoder()
    .decode(entry[1])
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FindingLine);
}

interface PanelInternals {
  handleMessage(message: unknown): Promise<void>;
}

function act(panel: ProposalPanel, message: unknown): Promise<void> {
  return (panel as unknown as PanelInternals).handleMessage(message);
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

describe("検知が出した指摘を残す", () => {
  test("誤字脱字の結果を出すと、指摘が置き場へ1行残る", async () => {
    const panel = new ProposalPanel();
    panel.showResults(work, [issue()]);
    await settle();

    const lines = savedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: "finding",
      original: "　彼女は振り返らなかった。",
      target: "振り返らなかった",
      suggestion: "振りかえらなかった",
      category: "typo",
      hintLine: 3,
    });
  });

  /**
   * **ここがずれると全件が黙って消える**（画面側は `Finding.file` で
   * 本文を引く）。区切りは `/` に揃える
   */
  test("残る file は、作品フォルダーからの相対パスで、区切りは / である", async () => {
    const panel = new ProposalPanel();
    panel.showResults(work, [issue()]);
    await settle();

    const [line] = savedLines();
    expect(line.kind === "finding" && line.file).toBe("本文/001.txt");
  });

  /** 前後は1行ずつでよい（`relocateQuote` がそこしか見ない）。空行は飛ばす */
  test("前後の文脈は、空行を飛ばした1行ずつが入る", async () => {
    const panel = new ProposalPanel();
    panel.showResults(work, [issue()]);
    await settle();

    expect(savedLines()[0]).toMatchObject({
      before: "　朝の廊下は静かだった。",
      after: "　窓の外で鐘が鳴る。",
    });
  });

  /** AIが本文に無い引用を返すことは実際にある（実装ルール3） */
  test("本文に無い原文の指摘は残さない", async () => {
    const panel = new ProposalPanel();
    panel.showResults(work, [
      { ...issue(), original: "　誰も居ない教室だった。" },
    ]);
    await settle();

    expect(savedLines()).toEqual([]);
  });

  test("矛盾も残る（種類は contradiction、直し方は空のまま）", async () => {
    const panel = new ProposalPanel();
    panel.showContradictions(work, [contradiction()]);
    await settle();

    expect(savedLines()[0]).toMatchObject({
      kind: "finding",
      category: "contradiction",
      target: "",
      suggestion: "",
    });
  });

  test("矛盾（事実の照合）も、同じ道で残る", async () => {
    const panel = new ProposalPanel();
    panel.showFactContradictions(work, [contradiction()]);
    await settle();

    expect(savedLines()).toHaveLength(1);
    expect(savedLines()[0]).toMatchObject({ category: "contradiction" });
  });

  /** `proposals.jsonl` に既に永続している（設計書5.6.1.1） */
  test("編集部からの提案は残さない", async () => {
    const panel = new ProposalPanel();
    const proposed: ProposalViewItem = {
      id: "p1",
      filePath: FILE,
      fileName: "001.txt",
      chunkHash: "h1",
      line: 3,
      original: "　彼女は振り返らなかった。",
      target: "振り返らなかった",
      suggestion: "振りかえらなかった",
      reason: "送り仮名",
      confidence: "high",
      status: "pending",
      proposalId: "pr-1",
    };
    panel.showProposals(work, [proposed]);
    await settle();

    expect(savedLines()).toEqual([]);
  });

  /** `.aiwriter/pending-characters/` に既に永続している */
  test("人物設定の更新案は残さない", async () => {
    const panel = new ProposalPanel();
    const update: RecordUpdateViewItem = {
      id: "u1",
      name: "中神隼人",
      changes: ["役割: 前 → 後"],
      source: "設定資料の抽出",
      status: "pending",
    };
    panel.showRecordUpdates(
      work,
      [update],
      async () => ({ ok: true }),
      async () => ({ ok: true })
    );
    await settle();

    expect(savedLines()).toEqual([]);
  });

  /**
   * **対応表に無い分類は残さない**（`core/findingSource.ts`）。
   * 名前の付け替えは「資料にも反映」と対になった一続きの操作である
   */
  test("対応表に無い分類（名前の付け替え）は残さない", async () => {
    const panel = new ProposalPanel();
    panel.showResults(work, [issue()], "名前の付け替え");
    await settle();

    expect(savedLines()).toEqual([]);
  });

  /**
   * **残し直すと `time` が今日になり、期限（3日）が数え直される。**
   * 開くたびに延命すると、永久に消えない指摘ができる
   */
  test("置き場から戻した指摘は、残し直さない", async () => {
    const panel = new ProposalPanel();
    panel.showRestoredFindings(work, "誤字脱字", {
      items: [
        {
          id: "fabc",
          filePath: FILE,
          fileName: "001.txt",
          chunkHash: "",
          line: 3,
          original: "　彼女は振り返らなかった。",
          target: "振り返らなかった",
          suggestion: "振りかえらなかった",
          reason: "誤字脱字",
          confidence: "medium",
          status: "pending",
        },
      ],
    });
    await settle();

    expect(savedLines()).toEqual([]);
  });
});

describe("作者の判断を足す", () => {
  test("適用すると、採ったことが追記される（指摘の行は書き換わらない）", async () => {
    const panel = new ProposalPanel();
    panel.showResults(work, [issue()]);
    await settle();
    const recorded = savedLines();

    await act(panel, { type: "apply", id: `h1:3:0` });
    await settle();

    const lines = savedLines();
    expect(lines).toHaveLength(2);
    // 先に書いた指摘の行はそのまま
    expect(lines[0]).toEqual(recorded[0]);
    expect(lines[1]).toMatchObject({
      kind: "decision",
      status: "accepted",
      findingId: recorded[0].kind === "finding" ? recorded[0].id : "",
    });
  });

  test("見送ると、退けたことが追記される", async () => {
    const panel = new ProposalPanel();
    panel.showResults(work, [issue()]);
    await settle();
    const recorded = savedLines();

    await act(panel, { type: "dismiss", id: `h1:3:0` });
    await settle();

    const lines = savedLines();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({
      kind: "decision",
      status: "dismissed",
      findingId: recorded[0].kind === "finding" ? recorded[0].id : "",
    });
  });

  test("矛盾を無視しても、退けたことが追記される", async () => {
    const panel = new ProposalPanel();
    panel.showContradictions(work, [contradiction()]);
    await settle();
    const recorded = savedLines();

    await act(panel, { type: "dismiss", id: "c:h1:3:0" });
    await settle();

    const lines = savedLines();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({
      kind: "decision",
      status: "dismissed",
      findingId: recorded[0].kind === "finding" ? recorded[0].id : "",
    });
  });

  /** 人物設定の更新案は残していないので、判断も足さない */
  test("人物設定の更新案を見送っても、置き場は空のままである", async () => {
    const panel = new ProposalPanel();
    panel.showRecordUpdates(
      work,
      [
        {
          id: "u1",
          name: "中神隼人",
          changes: ["役割: 前 → 後"],
          source: "設定資料の抽出",
          status: "pending",
        },
      ],
      async () => ({ ok: true }),
      async () => ({ ok: true })
    );
    await settle();

    await act(panel, { type: "dismiss", id: "u1" });
    await settle();

    expect(savedLines()).toEqual([]);
  });
});
