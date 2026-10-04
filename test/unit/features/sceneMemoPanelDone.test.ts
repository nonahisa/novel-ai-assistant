import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 校正・メモパネルの［済み］と、上の帯の［戻す］（設計書6.40.4。作者の裁定
 * 2026-10-04「［済み］の直後に戻す帯を出す。［直す］と同じ形にし、Ctrl+Z の
 * 動きは変えない」）。
 *
 * - ［済み］でメモの行を消したら、帯に「メモを済みにしました（第◯話　◯行目）」が出る
 * - 帯の［戻す］は、消した行を元の位置へ戻す。書き戻しは［済み］と同じ道
 *   （開いていれば文書へ、開いていなければ `writeTextFilePreservingFormat`）
 * - 本文が変わって元の位置が分からなければ、理由を出して何もしない（実装ルール1）
 *
 * 行の差し込み方そのもの（隣の行の照合・改行）は `core/sceneMemo.test.ts` が見る。
 * 画面で押して戻ることは E2E `sceneMemoJumps.test.ts` が見る。
 */

const posted: Array<{ type: string; data?: Record<string, unknown> }> = [];
let receive: ((message: unknown) => void) | undefined;
const warnings: string[] = [];

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn() },
    window: {
      showWarningMessage: vi.fn((text: string) => {
        warnings.push(text);
        return Promise.resolve(undefined);
      }),
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
        // 指摘の置き場は空（このテストは付箋だけを見る）
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

const FILE_PATH = "C:/小説/いじめられっ子/本文/003.txt";
const ORIGINAL = "三の一行目。\n// 三のメモ\n三の三行目。\n";

/** ディスクの本文（読むたびに版が変わる。ハッシュ照合の代わり） */
const disk = { text: ORIGINAL, version: 0 };

vi.mock("../../../src/core/scanner", () => ({
  scanWork: vi.fn(async () => ({
    episodes: [
      {
        filePath: "C:/小説/いじめられっ子/本文/003.txt",
        fileName: "003.txt",
        hasConflictMarkers: false,
      },
    ],
  })),
}));

vi.mock("../../../src/core/textFile", () => ({
  readTextFile: vi.fn(async () => ({
    text: disk.text,
    hash: `h${disk.version}`,
    encoding: "utf8",
    eol: "\n",
    bom: false,
  })),
  writeTextFilePreservingFormat: vi.fn(
    async (_path: string, next: string, _content: unknown, hash: string) => {
      // 読んだときの版でなければ断る（本物のハッシュ照合と同じ役）
      if (hash !== `h${disk.version}`) return { ok: false, reason: "modified_externally" };
      disk.text = next;
      disk.version += 1;
      return { ok: true };
    }
  ),
}));

vi.mock("../../../src/core/workFormatStore", () => ({
  readWorkFormat: vi.fn(async () => ({})),
}));

vi.mock("../../../src/core/episodeLabel", () => ({
  collectedLabelIndex: () => ({ labelAt: () => "第3話" }),
  episodeTitle: () => "",
  formatChapterLabel: () => "第3話",
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

import { openSceneMemoPanel } from "../../../src/features/sceneMemoPanel";
import {
  removeMemoLineInOpenManuscript,
  restoreMemoLineInOpenManuscript,
} from "../../../src/features/manuscriptEditor";
import { writeTextFilePreservingFormat } from "../../../src/core/textFile";
import { memoLineRemoval } from "../../../src/core/sceneMemo";
import type { WorkEntry } from "../../../src/models/types";

let workCount = 0;
function newWork(): WorkEntry {
  workCount += 1;
  return {
    id: `done${workCount}`,
    title: "いじめられっ子",
    folderPath: "C:/小説/いじめられっ子",
    registeredAt: "2026-10-04T00:00:00.000Z",
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

function banner(): { text: string; undoTitle: string } | null {
  return (lastData().fixed ?? null) as { text: string; undoTitle: string } | null;
}

async function open(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await openSceneMemoPanel(context as any, newWork(), {});
}

async function pressDone(): Promise<void> {
  receive?.({ type: "done", filePath: FILE_PATH, line: 2, raw: "// 三のメモ" });
  await settle();
}

async function pressUndo(): Promise<void> {
  receive?.({ type: "undoFix" });
  await settle();
}

beforeEach(() => {
  posted.length = 0;
  warnings.length = 0;
  receive = undefined;
  disk.text = ORIGINAL;
  disk.version = 0;
  vi.mocked(removeMemoLineInOpenManuscript).mockReset();
  vi.mocked(removeMemoLineInOpenManuscript).mockResolvedValue({ kind: "not_open" });
  vi.mocked(restoreMemoLineInOpenManuscript).mockReset();
  vi.mocked(restoreMemoLineInOpenManuscript).mockResolvedValue({ kind: "not_open" });
  vi.mocked(writeTextFilePreservingFormat).mockClear();
});

describe("閉じている話（ディスクを書き直す道）", () => {
  test("［済み］で行が消え、帯に「メモを済みにしました（第3話　2行目）」が出る", async () => {
    await open();
    expect(banner()).toBeNull();

    await pressDone();

    expect(disk.text).toBe("三の一行目。\n三の三行目。\n");
    expect(banner()?.text).toBe("メモを済みにしました（第3話　2行目）");
  });

  test("帯の［戻す］で、消した行が元の位置へ戻り、帯が下がる", async () => {
    await open();
    await pressDone();

    await pressUndo();

    expect(disk.text).toBe(ORIGINAL);
    expect(banner()).toBeNull();
    expect(warnings).toEqual([]);
    // 書き戻しはハッシュ照合つきの道（［済み］の1回と［戻す］の1回）
    expect(writeTextFilePreservingFormat).toHaveBeenCalledTimes(2);
  });

  test("済みにしたあとで本文が変わり元の位置が分からなければ、理由を出して何もしない", async () => {
    await open();
    await pressDone();
    // 作者が外で上に1行足した
    disk.text = "足した行。\n三の一行目。\n三の三行目。\n";
    disk.version += 1;

    await pressUndo();

    expect(disk.text).toBe("足した行。\n三の一行目。\n三の三行目。\n");
    expect(writeTextFilePreservingFormat).toHaveBeenCalledTimes(1);
    expect(warnings.join("")).toContain("元の位置が分からないため、メモを戻しませんでした");
    // 消えたメモの字を見せる（手で書き直せるように）
    expect(warnings.join("")).toContain("// 三のメモ");
    expect(banner()).toBeNull();
  });
});

describe("開いている話（原稿エディタの文書へ差し込む道）", () => {
  const removed = memoLineRemoval(ORIGINAL, 2, "// 三のメモ");
  if (!removed) throw new Error("控えが作れませんでした");

  test("［済み］で帯が出て、［戻す］は文書へ差し込む口へ控えを渡す（ディスクは書かない）", async () => {
    vi.mocked(removeMemoLineInOpenManuscript).mockResolvedValue({ kind: "removed", removed });
    vi.mocked(restoreMemoLineInOpenManuscript).mockResolvedValue({ kind: "restored" });
    await open();

    await pressDone();
    expect(banner()?.text).toBe("メモを済みにしました（第3話　2行目）");

    await pressUndo();

    expect(restoreMemoLineInOpenManuscript).toHaveBeenCalledWith(FILE_PATH, removed);
    expect(writeTextFilePreservingFormat).not.toHaveBeenCalled();
    expect(banner()).toBeNull();
  });

  test("文書の元の位置が分からなければ、理由を出して帯を下げる", async () => {
    vi.mocked(removeMemoLineInOpenManuscript).mockResolvedValue({ kind: "removed", removed });
    vi.mocked(restoreMemoLineInOpenManuscript).mockResolvedValue({ kind: "changed" });
    await open();
    await pressDone();

    await pressUndo();

    expect(writeTextFilePreservingFormat).not.toHaveBeenCalled();
    expect(warnings.join("")).toContain("メモを戻しませんでした");
    expect(banner()).toBeNull();
  });
});

test("消せなかった［済み］では帯を出さない", async () => {
  await open();
  // 読み込んでから押すまでに、その行が書き換わった
  disk.text = "三の一行目。\n// 別のメモ\n三の三行目。\n";
  disk.version += 1;

  await pressDone();

  expect(banner()).toBeNull();
  expect(warnings.join("")).toContain("このメモを消しませんでした");
});
