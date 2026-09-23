import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 提案パネル：バックアップとの違い（複数行の置き換え）を1か所ずつ当てる
 * （設計書6.99.7。作者の裁定、2026-09-23「違い1か所ずつを提案パネルに並べ、
 * 採るかどうかを箇所ごとに選べるようにする。段落の増減も扱えるよう、
 * 提案の形を広げる」）。
 *
 * 見るのは次の4つ——**書くことと書かないことを対で確かめる**。
 *
 * 1. 段落の増減を含む置き換えが、その箇所だけに当たる（戻すと元通り）
 * 2. 同じ話の別の箇所を当てても、残りの箇所はずれずに当たる
 * 3. **並べてから原稿が変わっていたら当てない**（ハッシュの照合）
 * 4. まとめて適用には乗らず、「手元のまま」は誤字脱字の記録へ入らない
 */

/** 偽の原稿。書き込みのたびに置き換わる */
let text = "";

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn() },
    window: {
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
      showErrorMessage: vi.fn(),
      showTextDocument: vi.fn(),
      visibleTextEditors: [],
      createOutputChannel: () => ({ appendLine: noop, show: noop, dispose: noop }),
    },
    workspace: {
      getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }),
      fs: { readFile: vi.fn(), writeFile: vi.fn(), createDirectory: vi.fn() },
      textDocuments: [],
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
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    ViewColumn: { One: 1 },
  };
});

/** ハッシュは中身そのものから作る（中身が変われば必ず変わる） */
const hashOf = (value: string) => `h:${value}`;

const writes: string[] = [];
vi.mock("../../src/core/textFile", () => ({
  readTextFile: vi.fn(async () => ({
    text,
    hash: hashOf(text),
    encoding: "utf8",
    eol: "\n",
    hasTrailingNewline: true,
  })),
  sameFilePath: (a: string, b: string) => a === b,
  // 本物と同じく、照合の相手が違えば書かない
  writeTextFilePreservingFormat: vi.fn(
    async (_path: string, next: string, _original: unknown, expectedHash: string) => {
      if (expectedHash !== hashOf(text)) {
        return { ok: false, reason: "modified_externally" };
      }
      text = next;
      writes.push(next);
      return { ok: true };
    }
  ),
}));

vi.mock("../../src/core/fileLockStore", () => ({
  FileLockStore: class {
    async lockFor(): Promise<undefined> {
      return undefined;
    }
  },
}));

const edits: Array<{ actor: string; action: string; detail?: string }> = [];
vi.mock("../../src/core/actorContext", () => ({
  isEditorMode: () => false,
  manualActor: () => "author",
  recordEdit: vi.fn(async (_work: unknown, entry: { actor: string; action: string }) => {
    edits.push(entry);
  }),
}));

/** 誤字脱字の「無視」の記録。**バックアップとの違いでは触らない** */
const typoDismissed: unknown[] = [];
vi.mock("../../src/core/typoIssueHistory", () => ({
  appendAiActionLog: vi.fn(async () => undefined),
  dismissKey: () => "key",
  TypoDismissedHistory: class {
    async add(keys: unknown[]): Promise<void> {
      typoDismissed.push(...keys);
    }
    async load(): Promise<Set<string>> {
      return new Set();
    }
  },
}));

import { ProposalPanel } from "../../src/features/proposalPanel";
import type { WorkEntry } from "../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "コールドスリープ",
  folderPath: "C:/小説/コールドスリープ",
  registeredAt: "2026-09-23T00:00:00.000Z",
};
const FILE = "C:/小説/コールドスリープ/本文/0002.txt";

/** 手元の原稿（2話）。本文は6行目から */
const ORIGINAL = [
  "------------------------- エピソード2開始 -------------------------",
  "【エピソードタイトル】",
  "2話　検査",
  "",
  "【本文】",
  "検査が続く。",
  "　白い部屋だった。",
  "　手元で書き足した段落。",
  "　窓は無い。",
  "",
].join("\n");

/** バックアップ側：1行目は字下げあり、3行目の段落は無く、最後に2行足されている */
function proposals() {
  return [
    {
      relPath: "本文/0002.txt",
      episodeLabel: "2話　検査",
      startLine: 6,
      local: ["検査が続く。"],
      backup: ["　検査が続く。"],
      fileHash: hashOf(ORIGINAL),
      filePath: FILE,
    },
    {
      relPath: "本文/0002.txt",
      episodeLabel: "2話　検査",
      startLine: 8,
      local: ["　手元で書き足した段落。"],
      backup: [],
      fileHash: hashOf(ORIGINAL),
      filePath: FILE,
    },
    {
      relPath: "本文/0002.txt",
      episodeLabel: "2話　検査",
      startLine: 10,
      local: [],
      backup: ["　サイトで足した段落。", "　もう1行。"],
      fileHash: hashOf(ORIGINAL),
      filePath: FILE,
    },
  ];
}

const posted: Array<{ type: string; canApplyAll?: boolean; items?: unknown[] }> = [];
function fakeView() {
  return {
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: (message: { type: string }) => {
        posted.push(message);
        return Promise.resolve(true);
      },
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  };
}

type Item = {
  id: string;
  status: string;
  statusDetail?: string;
  line: number;
  lineBlock?: { startLine: number; expectedHash: string };
};

function panelWithBlocks(): ProposalPanel {
  const panel = new ProposalPanel();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fakeView() as any);
  panel.showBackupDiffs(work, proposals());
  return panel;
}

function items(panel: ProposalPanel): Item[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (panel as any).items as Item[];
}

async function press(
  panel: ProposalPanel,
  type: "apply" | "undo" | "dismiss" | "applyAll",
  index = 0
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (panel as any).handleMessage({ type, id: items(panel)[index]?.id });
}

beforeEach(() => {
  text = ORIGINAL;
  writes.length = 0;
  edits.length = 0;
  typoDismissed.length = 0;
  posted.length = 0;
});

describe("1か所ずつ当てる", () => {
  test("字下げの違い（1行）を当てると、その行だけが変わる", async () => {
    const panel = panelWithBlocks();

    await press(panel, "apply", 0);

    expect(text).toBe(ORIGINAL.replace("\n検査が続く。", "\n　検査が続く。"));
    expect(items(panel)[0].status).toBe("applied");
    expect(edits[0]).toMatchObject({ actor: "author", action: "バックアップとの違いを採った" });
  });

  test("**段落を消す・足す**も、その箇所だけに当たる", async () => {
    const panel = panelWithBlocks();

    await press(panel, "apply", 2);
    await press(panel, "apply", 1);

    expect(text).toBe(
      [
        "------------------------- エピソード2開始 -------------------------",
        "【エピソードタイトル】",
        "2話　検査",
        "",
        "【本文】",
        "検査が続く。",
        "　白い部屋だった。",
        "　窓は無い。",
        "　サイトで足した段落。",
        "　もう1行。",
        "",
      ].join("\n")
    );
  });

  test("**前の箇所を当てたあとも、後ろの箇所はずれずに当たる**（行の数え直し・照合の付け替え）", async () => {
    const panel = panelWithBlocks();

    // 8行目の段落を消す → 10行目に足す箇所は9行目へずれる
    await press(panel, "apply", 1);
    expect(items(panel)[2].line).toBe(9);
    await press(panel, "apply", 2);
    await press(panel, "apply", 0);

    expect(items(panel).map((item) => item.status)).toEqual(["applied", "applied", "applied"]);
    expect(text).toBe(
      [
        "------------------------- エピソード2開始 -------------------------",
        "【エピソードタイトル】",
        "2話　検査",
        "",
        "【本文】",
        "　検査が続く。",
        "　白い部屋だった。",
        "　窓は無い。",
        "　サイトで足した段落。",
        "　もう1行。",
        "",
      ].join("\n")
    );
  });

  test("当てたあと「戻す」と、その箇所だけが手元の文へ戻る", async () => {
    const panel = panelWithBlocks();

    await press(panel, "apply", 1);
    await press(panel, "apply", 2);
    await press(panel, "undo", 1);

    expect(text).toBe(
      ORIGINAL.replace("　窓は無い。\n", "　窓は無い。\n　サイトで足した段落。\n　もう1行。\n")
    );
    expect(items(panel)[1].status).toBe("pending");
    expect(items(panel)[2].status).toBe("applied");
  });
});

describe("当てないとき", () => {
  test("**並べたあとで原稿が変わっていたら、当てない**", async () => {
    const panel = panelWithBlocks();
    text = `${ORIGINAL}　作者があとで書き足した。\n`;
    const before = text;

    await press(panel, "apply", 0);

    expect(text).toBe(before);
    expect(writes).toEqual([]);
    expect(items(panel)[0].status).toBe("failed");
    expect(items(panel)[0].statusDetail).toContain("原稿が変わっている");
  });

  test("当てたあとで原稿が変わっていたら、戻さない", async () => {
    const panel = panelWithBlocks();
    await press(panel, "apply", 0);
    text = `${text}　あとで書き足した。\n`;
    const before = text;

    await press(panel, "undo", 0);

    expect(text).toBe(before);
    expect(items(panel)[0].status).toBe("applied");
    expect(items(panel)[0].statusDetail).toContain("戻しませんでした");
  });

  test("「手元のまま」は原稿に触らず、誤字脱字の「無視」の記録にも入れない", async () => {
    const panel = panelWithBlocks();

    await press(panel, "dismiss", 1);

    expect(text).toBe(ORIGINAL);
    expect(items(panel)[1].status).toBe("dismissed");
    expect(typoDismissed).toEqual([]);
  });

  test("**まとめて適用には乗らない**（ボタンも出さない）", async () => {
    const panel = panelWithBlocks();

    await press(panel, "applyAll");

    expect(text).toBe(ORIGINAL);
    const last = posted.filter((message) => message.type === "issues").pop();
    expect(last?.canApplyAll).toBe(false);
  });
});
