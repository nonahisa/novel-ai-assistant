import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 校正・メモパネルの「Shift_JIS に無い字」の行（設計書5.4.2）。保存の直前に〓にした字の説明の行が、
 * 本文の〓といっしょに居続けるかを、本物のパネルの集め方（`collectMemos`）まで通して見る。
 *
 * 0.148.3 の担当の気づき（再現したい3つ）：
 * - (a) 指摘の置き場の決まりで、既定の3日で行が隠れる（〓が本文に残っていても）
 * - (b) 〓の隣の字を直すと行が消える（行の番号と探し直しが〓の前後4字から決まるため）
 * - (c) 前後4字が同じ別の〓は1行に畳まれる
 */

const files = new Map<string, Uint8Array>();
const posted: Array<{ type: string; data?: Record<string, unknown> }> = [];

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
          onDidReceiveMessage: () => ({ dispose: noop }),
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

const WORK_FOLDER = "C:/小説/作品";
const FILE_PATH = "C:/小説/作品/本文/001.txt";

/** いまの本文（テストごとに書き換える。作者が保存したあとの本文のつもり） */
let currentText = "";

vi.mock("../../../src/core/scanner", () => ({
  scanWork: vi.fn(async () => ({
    episodes: [{ filePath: "C:/小説/作品/本文/001.txt", fileName: "001.txt", hasConflictMarkers: false }],
  })),
}));

vi.mock("../../../src/core/textFile", () => ({
  readTextFile: vi.fn(async () => ({ text: currentText, hash: "h", encoding: "shift_jis", eol: "\n", bom: false })),
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
import { FindingStore } from "../../../src/features/findingStore";
import { planShiftJisSave } from "../../../src/core/sjisFallback";
import { buildSjisMarkFindings, SJIS_MARK_FINDING_LABEL } from "../../../src/core/sjisMarkFinding";
import { findingId, type Finding } from "../../../src/models/finding";
import type { WorkEntry } from "../../../src/models/types";

let workCount = 0;
function newWork(): WorkEntry {
  workCount += 1;
  return { id: `w${workCount}`, title: "作品", folderPath: WORK_FOLDER, registeredAt: "2026-11-01T00:00:00.000Z" };
}
const store = (): FindingStore =>
  new FindingStore({ id: "store", title: "作品", folderPath: WORK_FOLDER, registeredAt: "2026-11-01T00:00:00.000Z" });

const context = { subscriptions: [] as unknown[] };
const DAY = 24 * 60 * 60 * 1000;

/** 保存の直前の置き換えと同じ道で〓にし、その保存で残す行を置き場へ足す。保存された本文を返す */
async function saveWithMarks(text: string, time: string): Promise<{ saved: string; recorded: Finding[] }> {
  const plan = planShiftJisSave(text);
  const recorded = buildSjisMarkFindings(WORK_FOLDER, FILE_PATH, plan.text, plan.marks, undefined, time);
  await store().record(recorded);
  return { saved: plan.text, recorded };
}

function markRows(): Array<Record<string, unknown>> {
  const memos = posted.filter((message) => message.type === "memos");
  const rows = (memos[memos.length - 1]?.data?.rows ?? []) as Array<Record<string, unknown>>;
  return rows.filter((row) => typeof row.findingId === "string");
}

async function openPanel(): Promise<Array<Record<string, unknown>>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await openSceneMemoPanel(context as any, newWork(), {});
  return markRows();
}

beforeEach(() => {
  files.clear();
  posted.length = 0;
  currentText = "";
});

describe("(a) 〓が本文に残っている限り、行は隠さない", () => {
  test("既定の3日を過ぎても、〓が本文にあれば行が出る", async () => {
    const { saved } = await saveWithMarks("一行目。\nかきくけ♡さしすせ\n三行目。", new Date(Date.now() - 5 * DAY).toISOString());
    currentText = saved;
    const rows = await openPanel();
    expect(rows).toHaveLength(1);
    expect(rows[0].line).toBe(2);
  });

  test("ほかの指摘は、今までどおり3日で隠れる", async () => {
    currentText = "　彼は走つた。\n";
    const old = new Date(Date.now() - 5 * DAY).toISOString();
    await store().record([
      {
        id: findingId("本文/001.txt", "　彼は走つた。", "走つた", "走った", "typo", "誤字脱字"),
        time: old,
        file: "本文/001.txt",
        hintLine: 1,
        original: "　彼は走つた。",
        target: "走つた",
        suggestion: "走った",
        before: "",
        after: "",
        message: "促音の誤り",
        category: "typo",
        label: "誤字脱字",
      },
    ]);
    expect(await openPanel()).toEqual([]);
  });
});

describe("(b) 〓そのものが本文に残っていれば、前後の字を直しても行は消えない", () => {
  test("〓の左隣・右隣の字を直しても、行はその〓に出る", async () => {
    const { saved } = await saveWithMarks("一行目。\nかきくけ♡さしすせ\n三行目。", new Date().toISOString());
    expect(saved).toContain("かきくけ〓さしすせ");
    currentText = saved.replace("かきくけ〓さしすせ", "かきくこ〓たしすせ");
    const rows = await openPanel();
    expect(rows).toHaveLength(1);
    expect(rows[0].line).toBe(2);
  });

  test("〓の前後をまるごと書き直し、行も下へずれても、〓が残れば行は出る", async () => {
    const { saved } = await saveWithMarks("一行目。\nかきくけ♡さしすせ\n三行目。", new Date().toISOString());
    currentText = saved.replace("一行目。\n", "一行目。\n足した行。\n").replace("かきくけ〓さしすせ", "あいうえ〓おかきく");
    const rows = await openPanel();
    expect(rows.map((row) => row.line)).toEqual([3]);
  });

  test("〓を別の字に直したら、行は消える（今までどおり）", async () => {
    const { saved } = await saveWithMarks("かきくけ♡さしすせ", new Date().toISOString());
    currentText = saved.replace("〓", "♥");
    expect(await openPanel()).toEqual([]);
  });

  test("2つの〓のうち1つを直したら、行は1つだけ消え、残った〓の行は残る", async () => {
    const { saved, recorded } = await saveWithMarks("一つ目の♡です。\n二つ目の😀です。", new Date().toISOString());
    expect(recorded).toHaveLength(2);
    currentText = saved.replace("一つ目の〓", "一つ目のハート");
    const rows = await openPanel();
    expect(rows).toHaveLength(1);
    expect(rows[0].line).toBe(2);
    expect(rows[0].findingId).toBe(recorded[1].id);
  });
});

describe("(c) 〓1つにつき1行", () => {
  test("並んだ〓（♡♡）は2行になる", async () => {
    const { saved } = await saveWithMarks("あい♡♡うえ", new Date().toISOString());
    currentText = saved;
    expect(await openPanel()).toHaveLength(2);
  });

  test("前後4字が同じ別の行の〓は、それぞれの行に出る", async () => {
    const { saved } = await saveWithMarks("あいう♡えおか\n間の行。\nあいう♡えおか", new Date().toISOString());
    currentText = saved;
    const rows = await openPanel();
    expect(rows.map((row) => row.line)).toEqual([1, 3]);
  });

  test("片方を見送っても、もう片方は残る。見送った行は見送ったまま", async () => {
    const { saved, recorded } = await saveWithMarks("あいう♡えおか\n間の行。\nあいう♡えおか", new Date().toISOString());
    currentText = saved;
    await store().decide([{ findingId: recorded[0].id, time: new Date().toISOString(), status: "dismissed", note: "" }]);
    const rows = await openPanel();
    expect(rows.map((row) => row.findingId)).toEqual([recorded[1].id]);
    expect(rows[0].line).toBe(3);
  });
});

describe("見送った行と、前の版の番号の行", () => {
  test("見送った〓の前後をあとで直しても、見送ったまま（ほかの行に拾われて出てこない）", async () => {
    const { saved, recorded } = await saveWithMarks("一つ目の♡です。\n二つ目の😀です。", new Date().toISOString());
    await store().decide([{ findingId: recorded[0].id, time: new Date().toISOString(), status: "dismissed", note: "" }]);
    currentText = saved.replace("一つ目の〓です", "一番目〓だよ");
    const rows = await openPanel();
    expect(rows.map((row) => row.findingId)).toEqual([recorded[1].id]);
  });

  test("新しい行を見送ってその〓を直し、古い未決の行の〓の前後を両方書き直しても、見送った行は古い行の〓を取らない", async () => {
    const first = await saveWithMarks("一つ目の♡です。\n二\n三つ目の愛です。", new Date(Date.now() - 60_000).toISOString());
    const second = await saveWithMarks(first.saved.replace("愛", "♡"), new Date().toISOString());
    await store().decide([{ findingId: second.recorded[0].id, time: new Date().toISOString(), status: "dismissed", note: "" }]);
    // 見送った3行目の〓は直し、1行目の〓は残したまま前後を書き直した
    currentText = second.saved.replace("三つ目の〓です。", "三つ目のハートです。").replace("一つ目の〓です。", "まるで別〓の言葉だ");
    const rows = await openPanel();
    expect(rows.map((row) => row.findingId)).toEqual([first.recorded[0].id]);
    expect(rows[0].line).toBe(1);
  });

  test("〓を直して解決した行は、同じ話の行の無い〓（作者が自分で置いた〓）へ付き直さない", async () => {
    const { saved } = await saveWithMarks("かきくけ♡さしすせ\n間の行。\n終わりの行。", new Date().toISOString());
    currentText = saved.replace("〓", "愛").replace("終わりの行。", "〓は作者の印。");
    expect(await openPanel()).toEqual([]);
  });

  test("同じ場所にまた書けない字を打って〓にしたら、新しい行が出る（見送った古い行は戻さない）", async () => {
    const first = await saveWithMarks("かきくけ♡さしすせ", new Date(Date.now() - 60_000).toISOString());
    await store().decide([{ findingId: first.recorded[0].id, time: new Date().toISOString(), status: "dismissed", note: "" }]);
    // 作者が〓を消して、同じ場所にまた ♡ を打って保存した
    const second = await saveWithMarks(first.saved.replace("〓", "♡"), new Date().toISOString());
    currentText = second.saved;
    const rows = await openPanel();
    expect(rows.map((row) => row.findingId)).toEqual([second.recorded[0].id]);
    expect(second.recorded[0].id).not.toBe(first.recorded[0].id);
  });

  test("前の版の番号（前後4字から決めた番号）の行が残っていても、〓1つに行は1つ", async () => {
    // 0.152.10 までの形：番号は前後4字から決まり、♡♡は1行に畳まれていた
    const legacy: Finding = {
      id: findingId("本文/001.txt", "あい〓〓うえ", "〓", "", "other", SJIS_MARK_FINDING_LABEL),
      time: new Date().toISOString(),
      file: "本文/001.txt",
      hintLine: 1,
      original: "あい〓〓うえ",
      target: "〓",
      suggestion: "",
      before: "",
      after: "",
      message: "「♡」は Shift_JIS に無い字なので「〓」にしました。",
      category: "other",
      label: SJIS_MARK_FINDING_LABEL,
    };
    await store().record([legacy, legacy]);
    currentText = "あい〓〓うえ";
    const rows = await openPanel();
    expect(rows.map((row) => row.findingId)).toEqual([legacy.id]);
  });
});
