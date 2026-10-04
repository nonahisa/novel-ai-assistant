import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 校正・メモパネルの指摘の押し口（設計書6.96.5。作者の裁定 2026-10-03
 * 「［直す］1手で本文が直る」）。
 *
 * - 修正案のある指摘は［直す］——当てる口（`applyFinding`）が呼ばれ、
 *   提案パネルへは渡さない。当てたら上に［戻す］の帯が出る
 * - 修正案の無い指摘（矛盾・修正案の無い推敲）は［本文へ］——行の場所を押したときと
 *   同じ道で原稿のその行へ飛ぶ（作者の裁定 2026-10-04。以前の［提案へ］はやめた）
 * - 修正案の無い推敲には［AIに相談］も出る——相談の口（`consultFinding`）へ渡す
 *   （作者の要望 2026-10-04）。提案パネルへ移る口は上の［提案パネル］1つ
 * - ［戻す］は戻す口（`undoFindingFix`）を呼び、帯を下げる
 *
 * 当てる中身（本文・記録）は `proposalPanelFixFromMemo.test.ts` が本物の
 * 提案パネルで見る。ここは画面からの用件がどの口へ届くかだけを見る。
 */

const files = new Map<string, Uint8Array>();
/** 画面へ送ったもの（最後の一覧を見る） */
const posted: Array<{ type: string; data?: Record<string, unknown> }> = [];
/** 画面からの用件を受ける耳（パネルが付ける） */
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
    ViewColumn: { One: 1, Beside: -2 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3 },
  };
});

const FILE_PATH = "C:/小説/いじめられっ子/本文/003.txt";
const TEXT = "　彼は走つた。\n　夜が明けた。\n";

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
    text: "　彼は走つた。\n　夜が明けた。\n",
    hash: "h",
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
  collectedLabelIndex: () => ({ labelAt: () => "第3話" }),
  episodeTitle: () => "",
  formatChapterLabel: () => "第3話",
  isCollectedFile: () => false,
}));

vi.mock("../../../src/features/manuscriptEditor", () => ({
  lastManuscriptCaret: () => undefined,
  removeMemoLineInOpenManuscript: vi.fn(async () => ({ kind: "notOpen" })),
  restoreMemoLineInOpenManuscript: vi.fn(async () => ({ kind: "not_open" })),
}));

vi.mock("../../../src/features/revealLocation", () => ({
  revealTextLocation: vi.fn(async () => undefined),
}));

vi.mock("../../../src/views/openDocument", () => ({
  openGeneratedMarkdown: vi.fn(async () => undefined),
}));

import { openSceneMemoPanel } from "../../../src/features/sceneMemoPanel";
import { revealTextLocation } from "../../../src/features/revealLocation";
import { FindingStore } from "../../../src/features/findingStore";
import { findingId, type Finding } from "../../../src/models/finding";
import type { WorkEntry } from "../../../src/models/types";

const FILE = "本文/003.txt";

function stored(overrides: Partial<Finding>): Finding {
  return {
    id: "",
    time: new Date().toISOString(),
    file: FILE,
    hintLine: 1,
    original: "",
    target: "",
    suggestion: "",
    before: "",
    after: "",
    message: "",
    category: "typo",
    label: "誤字脱字",
    ...overrides,
  };
}

const typo = stored({
  id: findingId(FILE, "　彼は走つた。", "走つた", "走った", "typo", "誤字脱字"),
  original: "　彼は走つた。",
  target: "走つた",
  suggestion: "走った",
  message: "促音の誤り",
});

const contradiction = stored({
  id: findingId(FILE, "　夜が明けた。", "", "", "contradiction", "矛盾"),
  hintLine: 2,
  original: "　夜が明けた。",
  message: "前の話では昼だった",
  category: "contradiction",
  label: "矛盾",
});

/** 修正案の無い推敲の指摘（［本文へ］と［AIに相談］の行） */
const proofreadNoFix = stored({
  id: findingId(FILE, "　夜が明けた。", "", "", "proofread", "推敲"),
  hintLine: 2,
  original: "　夜が明けた。",
  message: "視点：ここだけ語り手が外から見ています",
  category: "proofread",
  label: "推敲",
});

/** 1つのテストで1つの作品（パネルは作品ごとに1枚なので、番号を変える） */
let workCount = 0;
function newWork(): WorkEntry {
  workCount += 1;
  return {
    id: `w${workCount}`,
    title: "いじめられっ子",
    folderPath: "C:/小説/いじめられっ子",
    registeredAt: "2026-10-03T00:00:00.000Z",
  };
}

const context = { subscriptions: [] as unknown[] };

/** 本文のその行へ飛ぶ道（行の場所を押したとき・［本文へ］） */
const revealed = vi.mocked(revealTextLocation);

async function settle(): Promise<void> {
  for (let round = 0; round < 10; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function lastData(): Record<string, unknown> {
  const memos = posted.filter((message) => message.type === "memos");
  return memos[memos.length - 1]?.data ?? {};
}

function rowOf(id: string): Record<string, unknown> | undefined {
  const rows = (lastData().rows ?? []) as Array<Record<string, unknown>>;
  return rows.find((row) => row.findingId === id);
}

beforeEach(async () => {
  files.clear();
  posted.length = 0;
  receive = undefined;
  await new FindingStore(newWorkForStore()).record([typo, contradiction, proofreadNoFix]);
  revealed.mockClear();
});

/** 置き場の場所は作品フォルダーで決まる（番号は関係ない） */
function newWorkForStore(): WorkEntry {
  return {
    id: "store",
    title: "いじめられっ子",
    folderPath: "C:/小説/いじめられっ子",
    registeredAt: "2026-10-03T00:00:00.000Z",
  };
}

/**
 * 偽の口。**本物と同じく、置き場に判断を足す**——当てた指摘は一覧から消え、
 * 戻すとまた並ぶ（帯の出し入れはこれを見て決まる）。
 */
function deps() {
  const decide = async (id: string, status: "accepted" | "pending") => {
    await new FindingStore(newWorkForStore()).decide([
      { findingId: id, time: new Date().toISOString(), status, note: "" },
    ]);
  };
  return {
    applyFinding: vi.fn(async (_work: WorkEntry, finding: { id: string }) => {
      await decide(finding.id, "accepted");
      return { ok: true as const };
    }),
    undoFindingFix: vi.fn(async (_work: WorkEntry, finding: { id: string }) => {
      await decide(finding.id, "pending");
      return { ok: true as const };
    }),
    consultFinding: vi.fn(async () => undefined),
    openProposals: vi.fn(),
  };
}

describe("修正案の有無で、押し口が分かれる", () => {
  test("修正案のある指摘は［直す］、無い指摘は［本文へ］", async () => {
    const work = newWork();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await openSceneMemoPanel(context as any, work, deps());

    expect(rowOf(typo.id)?.fixAction).toBe("apply");
    expect(rowOf(contradiction.id)?.fixAction).toBe("reveal");
    expect(rowOf(proofreadNoFix.id)?.fixAction).toBe("reveal");
    expect(lastData().fixed).toBeNull();
  });

  test("当てる口が無ければ、修正案があっても［本文へ］", async () => {
    const work = newWork();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await openSceneMemoPanel(context as any, work, {});

    expect(rowOf(typo.id)?.fixAction).toBe("reveal");
  });

  /** 作者の要望 2026-10-04「AIからの助言も欲しいです」 */
  test("［AIに相談］は修正案の無い推敲の指摘だけに出る（矛盾・修正案のある指摘には出さない）", async () => {
    const work = newWork();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await openSceneMemoPanel(context as any, work, deps());

    expect(rowOf(proofreadNoFix.id)?.canConsult).toBe(true);
    expect(rowOf(contradiction.id)?.canConsult).toBe(false);
    expect(rowOf(typo.id)?.canConsult).toBe(false);
  });

  test("相談の口が渡されていなければ、［AIに相談］を出さない", async () => {
    const work = newWork();
    const { applyFinding } = deps();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await openSceneMemoPanel(context as any, work, { applyFinding });

    expect(rowOf(proofreadNoFix.id)?.canConsult).toBe(false);
    // 提案パネルを開く口も無いので、上の［提案パネル］も出さない
    expect(lastData().canOpenProposals).toBe(false);
  });
});

describe("［本文へ］・［AIに相談］・［提案パネル］", () => {
  test("［本文へ］は行の場所を押したときと同じ道でその行へ飛び、本文へは当てない", async () => {
    const work = newWork();
    const given = deps();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await openSceneMemoPanel(context as any, work, given);

    // 画面の［本文へ］は、行の場所と同じ「reveal」を送る（sceneMemoPanelHtml.ts）
    receive?.({ type: "reveal", filePath: FILE_PATH, line: 2 });
    await settle();

    expect(revealed).toHaveBeenCalledTimes(1);
    expect(revealed.mock.calls[0]?.[0]).toBe(FILE_PATH);
    expect(revealed.mock.calls[0]?.[1]).toBe(2);
    expect(given.applyFinding).not.toHaveBeenCalled();
    expect(given.consultFinding).not.toHaveBeenCalled();
  });

  test("［AIに相談］は相談の口へ、その指摘（いまの行つき）を渡す。本文へは当てない", async () => {
    const work = newWork();
    const given = deps();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await openSceneMemoPanel(context as any, work, given);

    receive?.({ type: "consult", findingId: proofreadNoFix.id });
    await settle();

    expect(given.consultFinding).toHaveBeenCalledTimes(1);
    expect(given.consultFinding).toHaveBeenCalledWith(
      work,
      expect.objectContaining({
        id: proofreadNoFix.id,
        line: 2,
        original: "　夜が明けた。",
        message: "視点：ここだけ語り手が外から見ています",
      })
    );
    expect(given.applyFinding).not.toHaveBeenCalled();
  });

  test("上の［提案パネル］で、提案パネルを開く口が呼ばれる", async () => {
    const work = newWork();
    const given = deps();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await openSceneMemoPanel(context as any, work, given);
    expect(lastData().canOpenProposals).toBe(true);

    receive?.({ type: "openProposals" });
    await settle();

    expect(given.openProposals).toHaveBeenCalledTimes(1);
  });
});

describe("［直す］は当てる口へ", () => {
  test("［直す］で当てる口が呼ばれ、提案パネルへは渡さない。帯に［戻す］が出る", async () => {
    const work = newWork();
    const given = deps();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await openSceneMemoPanel(context as any, work, given);

    receive?.({ type: "fix", findingId: typo.id });
    await settle();

    expect(given.applyFinding).toHaveBeenCalledTimes(1);
    expect(given.applyFinding).toHaveBeenCalledWith(
      work,
      expect.objectContaining({ id: typo.id, line: 1, filePath: FILE_PATH })
    );
    expect(revealed).not.toHaveBeenCalled();
    expect(String((lastData().fixed as { text: string }).text)).toContain(
      "「走つた」→「走った」"
    );
  });

  test("修正案の無い指摘に［直す］が届いても、当てずにその行へ飛ぶだけ", async () => {
    const work = newWork();
    const given = deps();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await openSceneMemoPanel(context as any, work, given);

    receive?.({ type: "fix", findingId: contradiction.id });
    await settle();

    expect(given.applyFinding).not.toHaveBeenCalled();
    expect(revealed).toHaveBeenCalledTimes(1);
    expect(revealed.mock.calls[0]?.[1]).toBe(2);
  });

  test("当てられなかったら帯を出さない", async () => {
    const work = newWork();
    const given = {
      ...deps(),
      applyFinding: vi.fn(async () => ({ ok: false as const, reason: "本文が変わっています。" })),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await openSceneMemoPanel(context as any, work, given);

    receive?.({ type: "fix", findingId: typo.id });
    await settle();

    expect(lastData().fixed).toBeNull();
  });
});

describe("［戻す］", () => {
  test("戻す口を呼び、帯を下げる", async () => {
    const work = newWork();
    const given = deps();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await openSceneMemoPanel(context as any, work, given);
    receive?.({ type: "fix", findingId: typo.id });
    await settle();

    receive?.({ type: "undoFix" });
    await settle();

    expect(given.undoFindingFix).toHaveBeenCalledWith(
      work,
      expect.objectContaining({ id: typo.id })
    );
    expect(lastData().fixed).toBeNull();
  });

  test("戻す口が無ければ帯を出さない（押しても何も起きない口を作らない）", async () => {
    const work = newWork();
    const { applyFinding } = deps();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await openSceneMemoPanel(context as any, work, { applyFinding });
    receive?.({ type: "fix", findingId: typo.id });
    await settle();

    expect(lastData().fixed).toBeNull();
  });
});

/**
 * 種類ごとの色（作者の要望 2026-10-04「推敲や誤字脱字等で色分けしてください」
 * 「表示ジャンルすべてです」）。色の表そのものは `test/unit/core/noteTones.test.ts`。
 * ここでは、拡張機能が画面へ送る一覧に印が付くことを見る
 */
describe("種類ごとの色の印", () => {
  test("誤字脱字・矛盾・推敲の行に、それぞれ違う色の印が付く", async () => {
    const work = newWork();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await openSceneMemoPanel(context as any, work, deps());

    const tones = [typo, contradiction, proofreadNoFix].map(
      (finding) => rowOf(finding.id)?.tagClass
    );
    expect(tones.every((tone) => typeof tone === "string" && tone !== "")).toBe(true);
    expect(new Set(tones).size).toBe(3);
  });

  test("選び口に並ぶ種類すべてに印があり、その色が画面へ届く", async () => {
    const work = newWork();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await openSceneMemoPanel(context as any, work, deps());

    const data = lastData();
    const tags = data.tags as string[];
    const tagTones = data.tagTones as Record<string, string>;
    const colors = data.colors as Record<string, string>;
    expect(tags.length).toBeGreaterThanOrEqual(3);
    for (const tag of tags) {
      const tone = tagTones[tag];
      expect(tone, `${tag} に印が無い`).toBeTruthy();
      expect(colors[tone], `${tone} の色が届いていない`).toBeTruthy();
    }
    // 行の印と選び口の印は同じもの
    expect(tagTones["推敲"]).toBe(rowOf(proofreadNoFix.id)?.tagClass);
  });
});

// 本文の見本（この試験の偽の本文と、指摘の原文が合っていることの念押し）
test("見本の本文に、指摘の原文がある", () => {
  expect(TEXT).toContain(typo.original);
  expect(TEXT).toContain(contradiction.original);
});
