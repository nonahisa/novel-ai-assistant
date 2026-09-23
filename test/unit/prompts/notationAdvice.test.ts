import { beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 表記ゆれのAI問い合わせ（P-33、設計書6.73）。
 *
 * 表記ゆれ検知（6.11）は「『引っ越し』と『引越し』が混ざっている」とは
 * 教えてくれるが、**どちらに揃えるべきか**は教えてくれない（機械判定なので
 * 決められない）。その1組についてだけAIに1問だけ訊く道を、指摘のところに作る。
 *
 * ここで押さえるのは4つ。
 *
 *   1. 揺れの組の材料（各表記・出現数・出現例）が、そのままAIへ渡ること
 *   2. 答えは**指摘の下に出すだけ**で、本文は書き換えないこと
 *   3. 読めない答えは、理由を添えて出すこと（黙って何も起きない、をやめる）
 *   4. 有料の確認を断られたら、AIを**呼ばない**こと
 */

const posted: Array<{ category: string; items: unknown[] }> = [];
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
        readFile: vi.fn(() => Promise.resolve(new Uint8Array())),
        writeFile: vi.fn(() => Promise.resolve()),
        createDirectory: vi.fn(() => Promise.resolve()),
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
 * 接続確認と有料の確認は、ダイアログを出す部分なので差し替える。
 * **確認を通したか断ったかで、AIを呼ぶかどうかが変わる**ところを見たい。
 */
let reachable = true;
let paidAccepted = true;
vi.mock("../../src/features/aiConnectivity", () => ({
  confirmProviderReachable: vi.fn(async () => reachable),
  confirmPaidUsage: vi.fn(async () => paidAccepted),
}));

import { ProposalPanel } from "../../src/features/proposalPanel";
import type { WorkEntry } from "../../src/models/types";
import type { NotationAdviceGroup } from "../../src/prompts/notationAdvice";
import type { TypoCheckIssue } from "../../src/features/checkTypos";

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
  registeredAt: "2026-09-05T00:00:00.000Z",
};

/** 「引っ越し」と「引越し」の揺れ（検知から運ばれてくる材料） */
const group: NotationAdviceGroup = {
  label: "引っ越し ↔ 引越し",
  forms: [
    {
      surface: "引っ越し",
      count: 12,
      excerpts: ["春になったら引っ越しをする。", "引っ越しの荷物をまとめた。"],
    },
    {
      surface: "引越し",
      count: 3,
      excerpts: ["「引越し、いつなん？」と彼女は訊いた。"],
    },
  ],
};

const issue = {
  filePath: "C:/小説/いじめられっ子/本文/003.txt",
  chunkHash: "notation:003.txt:g1",
  line: 12,
  original: "春になったら引越しをする。",
  target: "引越し",
  suggestion: "引っ越し",
  reason: "表記ゆれ（「引っ越し」に揃える）。",
  confidence: "medium" as const,
  notation: group,
} as unknown as TypoCheckIssue & { notation: NotationAdviceGroup };

/** AIへ渡された問い（`generate` の引数） */
const asked: Array<{ userPrompt: string; model: string }> = [];
/** 次にAIが返す文字列。読めない答えを試すときは差し替える */
let nextAnswer = '{"choice":"引っ越し","reason":"公用文の送り仮名に合う"}';
/** AIの呼び出しで投げる例外（通信の失敗を試すとき） */
let nextError: Error | undefined;

function fakeRegistry(isPaid = false) {
  return {
    resolve: vi.fn(() => ({
      provider: {
        id: "ollama",
        displayName: "Ollama",
        isPaid,
        testConnection: vi.fn(async () => ({ ok: true })),
        generate: vi.fn(async (request: { userPrompt: string; model: string }) => {
          asked.push(request);
          if (nextError) throw nextError;
          return { text: nextAnswer, truncated: false };
        }),
      },
      model: "gemma4:e4b",
    })),
  };
}

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

function panelWithNotation(isPaid = false): ProposalPanel {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const panel = new ProposalPanel(fakeRegistry(isPaid) as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fakeView() as any);
  panel.showResults(work, [issue], "表記ゆれ");
  return panel;
}

function latest() {
  return posted[posted.length - 1];
}

/** いま出ている表記ゆれの指摘（画面へ送った形） */
function shown(): {
  id: string;
  notation?: NotationAdviceGroup;
  adviceNote?: string;
  askingAdvice?: boolean;
} {
  return latest().items[0] as {
    id: string;
    notation?: NotationAdviceGroup;
    adviceNote?: string;
    askingAdvice?: boolean;
  };
}

/** 「AIに訊く」を押したのと同じ（webviewからのメッセージ） */
async function press(panel: ProposalPanel, id: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (panel as any).handleMessage({ type: "askNotation", id });
}

beforeEach(() => {
  posted.length = 0;
  warned.length = 0;
  asked.length = 0;
  reachable = true;
  paidAccepted = true;
  nextError = undefined;
  nextAnswer = '{"choice":"引っ越し","reason":"公用文の送り仮名に合う"}';
});

describe("材料が指摘まで運ばれる", () => {
  test("表記ゆれの指摘は、揺れの組を持っている", () => {
    // これが無ければ「AIに訊く」は出せない（何を訊けばよいか分からない）
    panelWithNotation();
    expect(shown()).toMatchObject({ notation: { label: "引っ越し ↔ 引越し" } });
  });

  test("材料の無い指摘（誤字脱字）は持たない", () => {
    const panel = panelWithNotation();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { notation: _drop, ...typo } = issue as any;
    panel.showResults(work, [typo], "誤字脱字");
    expect(shown().notation).toBeUndefined();
  });
});

describe("AIに訊く", () => {
  test("揺れの組が、そのままAIへ渡る", async () => {
    const panel = panelWithNotation();
    await press(panel, shown().id);

    expect(asked).toHaveLength(1);
    const prompt = asked[0].userPrompt;
    // 表記と出現数（多いほうだけで決めさせないために両方を渡す）
    expect(prompt).toContain("引っ越し");
    expect(prompt).toContain("引越し");
    expect(prompt).toContain("12");
    expect(prompt).toContain("3");
    // 出現例（文体を読み取れるようにする）
    expect(prompt).toContain("春になったら引っ越しをする。");
    expect(prompt).toContain("「引越し、いつなん？」と彼女は訊いた。");
  });

  test("答えは、指摘の下に出す文になる", async () => {
    const panel = panelWithNotation();
    await press(panel, shown().id);

    const note = shown().adviceNote ?? "";
    expect(note).toContain("引っ越し");
    expect(note).toContain("公用文の送り仮名に合う");
  });

  test("「揃えない」も、そのまま答えとして出す", async () => {
    nextAnswer = '{"choice":"揃えない","reason":"会話文だけ「引越し」で、話者の癖と読める"}';
    const panel = panelWithNotation();
    await press(panel, shown().id);

    expect(shown().adviceNote).toContain("揃えない");
    expect(shown().adviceNote).toContain("話者の癖");
  });

  test("本文は書き換えない（指摘の状態は変わらない）", async () => {
    const panel = panelWithNotation();
    await press(panel, shown().id);

    expect(latest().items[0]).toMatchObject({ status: "pending" });
  });

  test("問い合わせが終わったら、押せる状態へ戻す", async () => {
    const panel = panelWithNotation();
    await press(panel, shown().id);

    expect(shown().askingAdvice).toBe(false);
    // 途中では立っていた（押した手応えを返している）
    const busySeen = posted.some((message) =>
      (message.items as Array<{ askingAdvice?: boolean }>).some(
        (item) => item.askingAdvice
      )
    );
    expect(busySeen).toBe(true);
  });
});

describe("うまくいかなかったとき", () => {
  test("読めない答えは、理由を添えて出す", async () => {
    nextAnswer = "どちらでもよいと思います";
    const panel = panelWithNotation();
    await press(panel, shown().id);

    expect(shown().adviceNote).toContain("読み取れませんでした");
  });

  test("選択肢に無い表記を答えたら、それは出さない", async () => {
    // **新しい表記を作ってくることがある。** 本文に一度も出ていない
    // 書き方へ揃えるよう勧めては困る
    nextAnswer = '{"choice":"ひっこし","reason":"読みやすい"}';
    const panel = panelWithNotation();
    await press(panel, shown().id);

    expect(shown().adviceNote).toContain("読み取れませんでした");
    expect(shown().adviceNote).not.toContain("ひっこし");
  });

  test("通信に失敗したら、理由を短く出す", async () => {
    nextError = new Error("接続できません");
    const panel = panelWithNotation();
    await press(panel, shown().id);

    expect(shown().adviceNote).toContain("訊けませんでした");
  });
});

describe("有料のAIを使うとき", () => {
  test("確認を断られたら、AIを呼ばない", async () => {
    paidAccepted = false;
    const panel = panelWithNotation(true);
    await press(panel, shown().id);

    expect(asked).toHaveLength(0);
    // 断ったのは作者なので、指摘の下に失敗を書き残さない
    expect(shown().adviceNote).toBeUndefined();
    expect(shown().askingAdvice).toBe(false);
  });

  test("繋がらなければ、AIを呼ばない", async () => {
    reachable = false;
    const panel = panelWithNotation();
    await press(panel, shown().id);

    expect(asked).toHaveLength(0);
  });

  test("承知すれば、1回だけ呼ぶ", async () => {
    const panel = panelWithNotation(true);
    await press(panel, shown().id);
    expect(asked).toHaveLength(1);
  });
});

describe("AIが設定されていないとき", () => {
  test("押しても黙って終わらせず、設定の場所を伝える", async () => {
    const panel = new ProposalPanel();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.resolveWebviewView(fakeView() as any);
    panel.showResults(work, [issue], "表記ゆれ");

    await press(panel, shown().id);

    expect(asked).toHaveLength(0);
    expect(warned.join("\n")).toContain("AI");
  });
});

/** 画面側の道（WebViewを要するので、口が残っているかだけを見る） */
describe("画面の問い合わせの口", () => {
  const html = () => readFileSync("src/views/proposalPanelHtml.ts", "utf-8");

  test("押すと askNotation を送る", () => {
    expect(html()).toContain('data-action="askNotation"');
  });

  test("材料のある指摘（表記ゆれ）にだけ出す", () => {
    // 押しても何も起きない口を作らない
    expect(html()).toContain("item.notation");
  });

  test("問い合わせ中は二度押せない", () => {
    expect(html()).toContain("item.askingAdvice");
  });

  test("答えを出す場所がある", () => {
    expect(html()).toContain("item.adviceNote");
  });
});
