import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 校正・メモパネルの「人物の重複の候補が N組あります」と［設定資料パネルで見る］
 * （作者の裁定 2026-10-19 夜。設計書6.40.4）。
 *
 * - 候補の一覧はこの画面に置かない。件数の知らせと、設定資料パネルへ連れて行くボタンだけ
 * - 0組なら出さない。開く口が渡されていなければ出さない（押せない口を作らない）
 * - 設定資料パネルで片づけたら、本文を読み直さずに件数だけ数え直す
 */

const posted: Array<{ type: string; data?: Record<string, unknown> }> = [];
let receive: ((message: unknown) => void) | undefined;

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn() },
    window: {
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
      showErrorMessage: vi.fn(),
      activeTextEditor: undefined,
      activeColorTheme: { kind: 1 },
      createOutputChannel: () => ({ appendLine: noop, show: noop, dispose: noop }),
      createWebviewPanel: () => ({
        webview: {
          html: "",
          cspSource: "vscode-webview:",
          onDidReceiveMessage: (handler: (message: unknown) => void) => {
            receive = handler;
            return { dispose: noop };
          },
          postMessage: (message: { type: string; data?: Record<string, unknown> }) => {
            posted.push(message);
            return Promise.resolve(true);
          },
        },
        onDidDispose: () => ({ dispose: noop }),
        reveal: noop,
        dispose: noop,
      }),
    },
    workspace: {
      getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }),
      fs: {
        readFile: vi.fn(async () => {
          throw new Error("FileNotFound");
        }),
        writeFile: vi.fn(async () => undefined),
        createDirectory: vi.fn(async () => undefined),
      },
    },
    Uri: { file: (p: string) => ({ fsPath: p }) },
    ViewColumn: { One: 1, Beside: -2 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3 },
  };
});

/** 人物の置き場の代わり。数え直しのたびにここを読む */
const cast = vi.hoisted(() => ({
  people: [] as Array<{ id: string; name: string }>,
  reads: 0,
}));

vi.mock("../../../src/core/characterStore", async () => {
  const { emptyCharacter } = await import("../../../src/models/character");
  return {
    CharacterStore: class {
      async loadAll() {
        cast.reads += 1;
        return {
          characters: cast.people.map((person) => emptyCharacter(person.id, person.name)),
          errors: [],
        };
      }
    },
  };
});

const scans = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../../src/core/scanner", () => ({
  scanWork: vi.fn(async () => {
    scans.count += 1;
    return {
      episodes: [
        { filePath: "C:/小説/見本/本文/001.txt", fileName: "001.txt", hasConflictMarkers: false },
      ],
    };
  }),
}));

vi.mock("../../../src/core/textFile", () => ({
  readTextFile: vi.fn(async () => ({
    text: "一行目。\n",
    hash: "h0",
    encoding: "utf8",
    eol: "\n",
    bom: false,
  })),
  writeTextFilePreservingFormat: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../../src/core/workFormatStore", () => ({
  readWorkFormat: vi.fn(async () => ({})),
}));

vi.mock("../../../src/core/episodeLabel", () => ({
  collectedLabelIndex: () => ({ labelAt: () => "第1話" }),
  episodeTitle: () => "",
  formatChapterLabel: () => "第1話",
  isCollectedFile: () => false,
}));

vi.mock("../../../src/features/manuscriptEditor", () => ({
  lastManuscriptCaret: () => undefined,
  removeMemoLineInOpenManuscript: vi.fn(async () => ({ kind: "not_open" })),
  restoreMemoLineInOpenManuscript: vi.fn(async () => ({ kind: "not_open" })),
}));

vi.mock("../../../src/features/revealLocation", () => ({
  revealTextLocation: vi.fn(async () => undefined),
}));

vi.mock("../../../src/views/openDocument", () => ({
  openGeneratedMarkdown: vi.fn(async () => undefined),
}));

import {
  openSceneMemoPanel,
  refreshSceneMemoMergeNotice,
  type SceneMemoDeps,
} from "../../../src/features/sceneMemoPanel";
import { buildSceneMemoPanelHtml } from "../../../src/views/sceneMemoPanelHtml";
import type { WorkEntry } from "../../../src/models/types";

let workCount = 0;
function newWork(): WorkEntry {
  workCount += 1;
  return {
    id: `merge${workCount}`,
    title: "見本",
    folderPath: "C:/小説/見本",
    registeredAt: "2026-10-19T00:00:00.000Z",
  };
}

const context = { subscriptions: [] as unknown[] };

async function settle(): Promise<void> {
  for (let round = 0; round < 10; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function lastData(): Record<string, unknown> {
  const memos = posted.filter((message) => message.type === "memos");
  return memos[memos.length - 1]?.data ?? {};
}

async function open(work: WorkEntry, deps: SceneMemoDeps): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await openSceneMemoPanel(context as any, work, deps);
  await settle();
}

/** 候補がちょうど2組になる顔ぶれ（省略形と、姓名と名だけ） */
const TWO_PAIRS = [
  { id: "char_001", name: "ギルドマスター" },
  { id: "char_002", name: "ギルマス" },
  { id: "char_003", name: "三門太志" },
  { id: "char_004", name: "太志" },
];

beforeEach(() => {
  posted.length = 0;
  receive = undefined;
  cast.people = [...TWO_PAIRS];
  cast.reads = 0;
  scans.count = 0;
});

describe("知らせ", () => {
  test("候補があれば「人物の重複の候補が N組あります」を出す", async () => {
    await open(newWork(), { openMergeCandidates: vi.fn(async () => undefined) });
    expect(lastData().mergeNotice).toBe("人物の重複の候補が 2組あります");
  });

  test("0組なら出さない", async () => {
    cast.people = [
      { id: "char_001", name: "密倉文佳" },
      { id: "char_002", name: "春原月夜" },
    ];
    await open(newWork(), { openMergeCandidates: vi.fn(async () => undefined) });
    expect(lastData().mergeNotice).toBeNull();
  });

  test("設定資料パネルを開く口が無ければ、知らせも出さず、人物も読まない", async () => {
    await open(newWork(), {});
    expect(lastData().mergeNotice).toBeNull();
    expect(cast.reads).toBe(0);
  });
});

describe("［設定資料パネルで見る］", () => {
  test("押すと、この作品で設定資料パネルの候補の欄を開く口を呼ぶ", async () => {
    const work = newWork();
    const openMergeCandidates = vi.fn(async () => undefined);
    await open(work, { openMergeCandidates });

    receive?.({ type: "openMergeCandidates" });
    await settle();

    expect(openMergeCandidates).toHaveBeenCalledWith(work);
  });
});

describe("設定資料パネルで片づけたあと", () => {
  test("本文を読み直さずに件数だけ数え直し、0組になったら知らせを下げる", async () => {
    const work = newWork();
    await open(work, { openMergeCandidates: vi.fn(async () => undefined) });
    const scansBefore = scans.count;

    // 1組まとめた（太志は三門太志の別名になり、記録は1件減る）
    cast.people = TWO_PAIRS.filter((person) => person.id !== "char_004");
    await refreshSceneMemoMergeNotice(work.id);
    expect(lastData().mergeNotice).toBe("人物の重複の候補が 1組あります");

    cast.people = TWO_PAIRS.filter((person) => person.id === "char_001" || person.id === "char_003");
    await refreshSceneMemoMergeNotice(work.id);
    expect(lastData().mergeNotice).toBeNull();

    expect(scans.count).toBe(scansBefore);
  });
});

describe("画面", () => {
  const html = buildSceneMemoPanelHtml("test-nonce", "vscode-resource:");

  test("知らせとボタンだけを置き、一覧は置かない", () => {
    expect(html).toContain('id="mergeNotice" hidden');
    expect(html).toContain(">設定資料パネルで見る</button>");
    expect(html).toContain('post("openMergeCandidates")');
    // 0組（null）なら隠す
    expect(html).toContain("el.mergeNotice.hidden = !data.mergeNotice");
    // まとめる・別人のボタンはこの画面に無い
    expect(html).not.toContain("unifyPair");
    expect(html).not.toContain("distinctPair");
  });
});
