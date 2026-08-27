import { describe, expect, test, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 矛盾・プロット逸脱の再チェック（P-23）。
 *
 * 作者の依頼（2026-08-27）：「誤字をなおした後、再確認したい」。
 * 矛盾の指摘（本文の「プリム様」が設定の「プラム」と食い違う）を見て
 * 本文を手で直したのに、**矛盾・逸脱には「再チェック」が無かった**。
 * 誤字脱字・推敲・表記ゆれには 0.22.26 で付けたが、こちらは描画が別
 * （`ContradictionViewItem`）で配線されていなかった。
 *
 * ここで押さえるのは3つ。
 *
 * 1. **AIへ渡す理由が、食い違いの中身になっていること。** 見出しは
 *    持ち回りのもの（矛盾は「設定では」、逸脱は「プロットでは」）を使う
 * 2. **解消したら一覧から外れること**（誤字脱字側と同じ扱い）
 * 3. **確かめられなかったものを消さないこと。** 本文が変わっていなければ
 *    その旨を添えるだけで、指摘は残る
 */

const posted: Array<{ category: string; items: unknown[] }> = [];
const notified: string[] = [];
const warned: string[] = [];

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn() },
    window: {
      showWarningMessage: vi.fn((message: string) => {
        warned.push(message);
        return Promise.resolve(undefined);
      }),
      showInformationMessage: vi.fn((message: string) => {
        notified.push(message);
        return Promise.resolve(undefined);
      }),
      showErrorMessage: vi.fn(),
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

/** 本文の読み込み。**再チェックはファイルを読むところから始まる** */
vi.mock("../../src/core/textFile", () => ({
  readTextFile: vi.fn(async () => ({
    text: "　夕暮れの校庭に、影が長く伸びていた。\n　プリム様は振り返らなかった。\n",
    hash: "h",
    encoding: "utf8",
    eol: "\n",
    bom: false,
  })),
  sameFilePath: () => false,
  writeTextFilePreservingFormat: vi.fn(),
}));

/** AIの呼び出しそのものは `recheckProposal.test.ts` で見る。ここは配線を見る */
const recheckCalls: Array<{
  category: string;
  fileName: string;
  item: {
    line: number;
    original: string;
    target: string;
    suggestion: string;
    reason: string;
  };
}> = [];
/** 次の再チェックが返す結果 */
let nextOutcome: { kind: string; reason?: string } = {
  kind: "resolved",
  reason: "設定どおりの表記に直っています",
};

vi.mock("../../src/features/recheckProposal", () => ({
  recheckProposal: vi.fn(async (request: (typeof recheckCalls)[number]) => {
    recheckCalls.push(request);
    return nextOutcome;
  }),
}));

import { ProposalPanel } from "../../src/features/proposalPanel";
import type { WorkEntry } from "../../src/models/types";

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

function latest() {
  return posted[posted.length - 1];
}

/** AIは設定済みで、無料のもの（有料の確認ダイアログを挟まない） */
function fakeRegistry() {
  return {
    resolve: () => ({
      provider: { isPaid: false, generate: vi.fn() },
      model: "gemma4:e4b",
    }),
  };
}

function panelWithView() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const panel = new ProposalPanel(fakeRegistry() as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fakeView() as any);
  return panel;
}

/** 本文の「プリム様」が、設定の「プラム」と食い違う（作者が実機で見たもの） */
const contradiction = {
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

/** プロット逸脱。**見出しの言葉が矛盾と違う**（プロットでは／この話では） */
const deviation = {
  filePath: "C:/小説/いじめられっ子/本文/003.txt",
  chunkHash: "h2",
  lineStart: 2,
  lineEnd: 2,
  excerpt: "　プリム様は振り返らなかった。",
  type: "逸脱",
  plotReference: "第3話で再会するはず",
  reason: "この話では再会していない",
  confidence: "high" as const,
};

/** 「再チェック」を押したのと同じ（webviewからのメッセージ） */
async function pressRecheck(panel: ProposalPanel, id: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (panel as any).handleMessage({ type: "recheck", id });
}

/** いま画面に出ている矛盾（実体。画面へ送るときの複製ではない） */
function contradictionsOf(panel: ProposalPanel): Array<{
  id: string;
  status: string;
  recheckNote?: string;
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (panel as any).contradictions;
}

beforeEach(() => {
  posted.length = 0;
  notified.length = 0;
  warned.length = 0;
  recheckCalls.length = 0;
  nextOutcome = { kind: "resolved", reason: "設定どおりの表記に直っています" };
});

describe("矛盾にも再チェックを出す", () => {
  test("矛盾の指摘には出す", () => {
    const panel = panelWithView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.showContradictions(work, [contradiction as any]);
    expect(latest().items[0]).toMatchObject({ canRecheck: true });
  });

  test("プロット逸脱の指摘にも出す", () => {
    const panel = panelWithView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.showDeviations(work, [deviation as any]);
    expect(latest().items[0]).toMatchObject({ canRecheck: true });
  });
});

describe("AIへ渡す理由の組み立て", () => {
  /**
   * **食い違いの中身を渡さないと、AIには何を見ればよいか分からない。**
   * P-23は汎用の形（category と reason）なので、矛盾の中身はここで組む。
   */
  test("矛盾では、設定と本文の両方を1つの文にする", async () => {
    const panel = panelWithView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.showContradictions(work, [contradiction as any]);
    await pressRecheck(panel, contradictionsOf(panel)[0].id);

    expect(recheckCalls).toHaveLength(1);
    const reason = recheckCalls[0].item.reason;
    expect(reason).toContain("設定では");
    expect(reason).toContain("プラム");
    expect(reason).toContain("本文では");
    expect(reason).toContain("プリム様");
    // 補足（呼称の揺れかもしれません）も落とさない
    expect(reason).toContain("呼称の揺れかもしれません");
  });

  /** **見出しは持ち回りのものを使う。** 逸脱を「設定では」と言わない */
  test("プロット逸脱では、プロット側の見出しを使う", async () => {
    const panel = panelWithView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.showDeviations(work, [deviation as any]);
    await pressRecheck(panel, contradictionsOf(panel)[0].id);

    const reason = recheckCalls[0].item.reason;
    expect(reason).toContain("プロットでは");
    expect(reason).toContain("第3話で再会するはず");
    expect(reason).toContain("この話では");
    expect(reason).toContain("この話では再会していない");
    expect(reason).not.toContain("設定では");
  });

  /** **矛盾には修正案が無い。** どちらが正しいかは作者にしか決められない */
  test("引用は抜粋、修正案は空で渡す", async () => {
    const panel = panelWithView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.showContradictions(work, [contradiction as any]);
    await pressRecheck(panel, contradictionsOf(panel)[0].id);

    expect(recheckCalls[0].item).toMatchObject({
      line: 2,
      original: "　プリム様は振り返らなかった。",
      target: "　プリム様は振り返らなかった。",
      suggestion: "",
    });
    // 分類の名前は、そのバケツのもの（AIへ「何の指摘か」を伝える）
    expect(recheckCalls[0].category).toBe("矛盾");
    expect(recheckCalls[0].fileName).toBe("003.txt");
  });
});

describe("結果の反映", () => {
  test("解消したら、一覧から外す印を立てる", async () => {
    const panel = panelWithView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.showContradictions(work, [contradiction as any]);
    await pressRecheck(panel, contradictionsOf(panel)[0].id);

    expect(contradictionsOf(panel)[0].status).toBe("resolved");
    // 誤字脱字側と同じく、印を付けて送り、画面のCSSで隠す
    expect(latest().items[0]).toMatchObject({ status: "resolved" });
    expect(
      (latest().items[0] as { recheckNote?: string }).recheckNote
    ).toContain("解消を確認しました");
    // 残りの件数からも外れる
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((panel as any).view.badge).toBeUndefined();
  });

  /**
   * **直し忘れは、AIを呼ばずに分かる。** その場で伝えるのがいちばん役に立つ
   */
  test("本文が変わっていなければ、その旨を添えて指摘は残す", async () => {
    nextOutcome = { kind: "unchanged" };
    const panel = panelWithView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.showContradictions(work, [contradiction as any]);
    await pressRecheck(panel, contradictionsOf(panel)[0].id);

    const item = contradictionsOf(panel)[0];
    expect(item.status).toBe("pending");
    expect(item.recheckNote).toContain("本文がまだ変わっていません");
    expect(notified.join("\n")).toContain("まだ書き直されていません");
  });

  /** **まだ当てはまるなら、理由を添えて残す**（消さない） */
  test("まだ当てはまるなら、指摘は残る", async () => {
    nextOutcome = { kind: "unresolved", reason: "まだ「プリム様」のままです" };
    const panel = panelWithView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.showContradictions(work, [contradiction as any]);
    await pressRecheck(panel, contradictionsOf(panel)[0].id);

    const item = contradictionsOf(panel)[0];
    expect(item.status).toBe("pending");
    expect(item.recheckNote).toContain("まだ当てはまります");
    expect(item.recheckNote).toContain("まだ「プリム様」のままです");
  });

  /** 押した手応え。**終わったら必ず戻す**（押せないままの行を残さない） */
  test("終わったら、再チェック中の印は下ろす", async () => {
    const panel = panelWithView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.showContradictions(work, [contradiction as any]);
    await pressRecheck(panel, contradictionsOf(panel)[0].id);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((contradictionsOf(panel)[0] as any).busy).toBe(false);
    // 途中では立っていた（押した手応えを返している）
    const busySeen = posted.some((message) =>
      (message.items as Array<{ busy?: boolean }>).some((item) => item.busy)
    );
    expect(busySeen).toBe(true);
  });
});

/**
 * 画面側の口（WebViewを要するので、その道が残っているかを見る）。
 */
describe("矛盾の描画に、再チェックの口がある", () => {
  /** `renderContradiction` の中身だけを取り出す（誤字脱字側と混ざらないように） */
  function renderContradictionSource(): string {
    const html = readFileSync("src/views/proposalPanelHtml.ts", "utf-8");
    const from = html.indexOf("function renderContradiction(item)");
    expect(from).toBeGreaterThan(0);
    const to = html.indexOf("\nfunction ", from + 1);
    return html.slice(from, to);
  }

  test("再チェックのボタンがある", () => {
    // 正規表現もエスケープも使わない。潰れても「見つからない」としか出ない
    expect(renderContradictionSource()).toContain('data-action="recheck"');
  });

  test("再チェック中は、その行の操作を止める", () => {
    const source = renderContradictionSource();
    expect(source).toContain("再チェック中…");
    expect(source).toContain("item.busy ? ' disabled' : ''");
  });

  test("解消が確かめられたものは、一覧から外す", () => {
    const source = renderContradictionSource();
    expect(source).toContain("'resolved'");
    // 隠すCSSは誤字脱字側と共用
    const html = readFileSync("src/views/proposalPanelHtml.ts", "utf-8");
    expect(html).toContain(".issue.resolved { display: none; }");
  });

  test("再チェックの結果を書く場所がある", () => {
    expect(renderContradictionSource()).toContain("recheck-note");
  });
});
