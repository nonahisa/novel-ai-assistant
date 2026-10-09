import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 場所の位置関係の照合を、AI の矛盾検知とは別に単独で走らせたときの並べ方
 * （設計書6.93.9 の順6・6.93.4。作者の裁定 2026-10-09 夜）。
 *
 * 1. **AI の指摘を消さない。** 単独の照合は AI を呼ばないので、AI の指摘の
 *    中身は渡さない。それでも同じ「矛盾」の分類に、AI の指摘が残っていること
 * 2. **前回の照合の行のうち、まだ手を付けていないものは入れ替える。**
 *    直したあとに照合し直しても、消えた食い違いの行が残り続けないように。
 *    作者が「無視」したものは残す（作者の判断）
 * 3. **根拠も話数も無い食い違い**（作者が書いた関係どうし）は、「場所の資料を
 *    開く」行として並べ、押すとその場所の資料が開く。校正・メモパネルの
 *    置き場（本文の位置で並ぶ）へは書かない
 */

const posted: Array<{ category: string; items: unknown[] }> = [];
const executed: Array<{ command: string; args: unknown[] }> = [];

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: {
      executeCommand: vi.fn((command: string, ...args: unknown[]) => {
        executed.push({ command, args });
        return Promise.resolve(undefined);
      }),
    },
    window: {
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
      showErrorMessage: vi.fn(),
      setStatusBarMessage: vi.fn(() => ({ dispose: noop })),
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
    ThemeIcon: class {},
    ThemeColor: class {},
    MarkdownString: class {},
    Range: class {},
    Position: class {},
    ViewColumn: { One: 1 },
  };
});

vi.mock("../../../src/core/textFile", () => ({
  readTextFile: vi.fn(async () => ({
    text: "　港は学校の北に見えた。\n",
    hash: "h",
    encoding: "utf8",
    eol: "\n",
    bom: false,
  })),
  sameFilePath: () => false,
  writeTextFilePreservingFormat: vi.fn(),
}));

/** 指摘の置き場（校正・メモパネルが読む）へ何が書かれたか */
const recorded: Array<{ filePath: string }> = [];
vi.mock("../../../src/features/findingRecorder", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    recordFindings: vi.fn(async (_work: unknown, drafts: Array<{ filePath: string }>) => {
      recorded.push(...drafts);
    }),
  };
});

import { ProposalPanel } from "../../../src/features/proposalPanel";
import type { WorkEntry } from "../../../src/models/types";
import type {
  LocationContradictionIssue,
  LocationRecordIssue,
} from "../../../src/core/locationConsistency";

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
  registeredAt: "2026-08-21T00:00:00.000Z",
};

function fakeView() {
  return {
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: (message: { category: string; items: unknown[] }) => {
        posted.push(message);
        return Promise.resolve(true);
      },
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  };
}

function panelWithView(): ProposalPanel {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const panel = new ProposalPanel(undefined as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fakeView() as any);
  return panel;
}

function contradictionsOf(panel: ProposalPanel): Array<Record<string, unknown>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (panel as any).contradictions;
}

/** AI の指摘（P-12） */
const aiIssue = {
  filePath: "C:/小説/いじめられっ子/本文/003.txt",
  chunkHash: "h1",
  line: 2,
  excerpt: "　プリム様は振り返らなかった。",
  category: "人物",
  settingSays: "プラム",
  textSays: "プリム様",
  note: "呼称の揺れかもしれません",
  confidence: "high" as const,
};

function locationIssue(line: number): LocationContradictionIssue {
  return {
    kind: "direction",
    filePath: "C:/小説/いじめられっ子/本文/007.txt",
    line,
    excerpt: "港は学校の北に見えた",
    category: "場所",
    settingSays: "第3話：学校は港の北（「学校は港の北の高台にある」）",
    textSays: "第7話：港は学校の北（「港は学校の北に見えた」）",
    note: "学校と港の方角が食い違っています。AIを使わず、設定資料の位置関係を照らしました。",
    confidence: "high",
  };
}

const recordIssue: LocationRecordIssue = {
  kind: "distance",
  locationId: "loc_002",
  locationName: "学校",
  filePath: "C:/小説/いじめられっ子/設定/locations/loc_002_学校.json",
  summary: "港と学校の距離が食い違っています（徒歩10分／徒歩2時間）",
  settingSays: "港は学校から徒歩2時間（作者が書いた関係）",
  textSays: "学校は港から徒歩10分（作者が書いた関係）",
};

beforeEach(() => {
  posted.length = 0;
  executed.length = 0;
  recorded.length = 0;
});

describe("場所の位置関係を単独で照合したときの並べ方", () => {
  test("AI の指摘のあとに単独の照合を並べても、AI の指摘は消えない", () => {
    const panel = panelWithView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.showContradictions(work, [aiIssue as any], async () => ({ ok: true }));
    panel.showLocationContradictions(work, [locationIssue(3)], []);

    const rows = contradictionsOf(panel);
    expect(rows.map((row) => row.category)).toEqual(["人物", "場所"]);
    // 伏線として登録の口も、AI の行には残る（単独の照合が上書きしない）
    expect(rows[0]).toMatchObject({ canRegisterForeshadow: true });
  });

  test("照合し直すと、手を付けていない前回の照合の行は入れ替わり、無視した行と AI の指摘は残る", async () => {
    const panel = panelWithView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.showContradictions(work, [aiIssue as any]);
    panel.showLocationContradictions(work, [locationIssue(3), locationIssue(5)], [recordIssue]);
    expect(contradictionsOf(panel)).toHaveLength(4);

    // 2件目の照合の行を作者が「無視」した
    const second = contradictionsOf(panel).filter((row) => row.category === "場所")[1];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (panel as any).handleMessage({ type: "dismiss", id: second.id });

    // 作者が資料を直して、食い違いが1つも無くなった
    panel.showLocationContradictions(work, [], []);
    const rows = contradictionsOf(panel);
    expect(rows.map((row) => [row.category, row.status])).toEqual([
      ["人物", "pending"],
      ["場所", "dismissed"],
    ]);
  });

  test("根拠も話数も無い食い違いは「場所の資料を開く」行になり、押すとその場所の資料が開く", async () => {
    const panel = panelWithView();
    panel.showLocationContradictions(work, [], [recordIssue]);
    const [row] = contradictionsOf(panel);
    expect(row).toMatchObject({
      category: "場所",
      jumpLabel: "場所の資料を開く",
      // 照らす相手のボタンは出さない（押す先は同じ場所の資料なので、2つ並べない）
      openTarget: "none",
      canRegisterForeshadow: false,
      allowRecheck: false,
      settingSays: recordIssue.settingSays,
      textSays: recordIssue.textSays,
    });
    // 本文の行は持たないので、見出しに「N行目」を出さない
    expect(row.headLabel).toBe("学校（場所の資料）");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (panel as any).handleMessage({ type: "jump", id: row.id });
    expect(executed).toContainEqual({
      command: "novelai.openSettingsPanel",
      args: [{ type: "work", work }, { kind: "location", id: "loc_002" }],
    });
  });

  test("「場所の資料を開く」行は、校正・メモパネルの置き場へ書かない（本文の位置を持たない）", async () => {
    const panel = panelWithView();
    panel.showLocationContradictions(work, [locationIssue(3)], [recordIssue]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recorded.map((draft) => draft.filePath)).toEqual([
      "C:/小説/いじめられっ子/本文/007.txt",
    ]);
  });
});

/**
 * 「場所の資料を開く」行は校正・メモパネルに並ばないので、1件でもあれば提案パネルを
 * 開く（作者の裁定 2026-10-10）。矛盾検知の終わり（`showContradictions`）でも、
 * 単独の照合でも同じ。書いている手から焦点は奪わない。
 */
describe("「場所の資料を開く」行があれば提案パネルを開く", () => {
  const opened = () =>
    executed.filter((entry) => entry.command === "novelai.openProposals");

  test("矛盾検知の終わりに1件以上あれば開く（焦点は奪わない）", () => {
    const panel = panelWithView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.showContradictions(work, [aiIssue as any], undefined, [], [recordIssue]);
    expect(opened()).toEqual([
      { command: "novelai.openProposals", args: [{ preserveFocus: true }] },
    ]);
  });

  test("単独の照合でも開く", () => {
    const panel = panelWithView();
    panel.showLocationContradictions(work, [], [recordIssue]);
    expect(opened()).toHaveLength(1);
  });

  test("無ければ開かない（本文に置ける行は校正・メモパネルに並ぶ）", () => {
    const panel = panelWithView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.showContradictions(work, [aiIssue as any], undefined, [locationIssue(3)], []);
    panel.showLocationContradictions(work, [locationIssue(3)], []);
    expect(opened()).toEqual([]);
  });

  test("略図の赤い線から行を示すときは、本文を開いてから提案パネルを前に出す（本文で隠さない）", async () => {
    const panel = panelWithView();
    panel.showLocationContradictions(work, [locationIssue(3)], [], { quiet: true });
    const order: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spied = panel as any;
    spied.jumpTo = vi.fn(async () => {
      order.push("本文");
    });
    spied.reveal = vi.fn(() => {
      order.push("提案パネル");
    });
    const [row] = contradictionsOf(panel);
    expect(await panel.focusContradiction(work, row.id as string)).toBe(true);
    expect(order).toEqual(["本文", "提案パネル"]);
    expect(spied.reveal).toHaveBeenCalledWith({ preserveFocus: true });
  });

  test("略図から静かに並べるとき（quiet）は、ここでは開かない（続けて行を示す側が開く）", () => {
    const panel = panelWithView();
    panel.showLocationContradictions(work, [], [recordIssue], { quiet: true });
    expect(opened()).toEqual([]);
  });
});
