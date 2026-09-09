import { beforeEach, describe, expect, test, vi } from "vitest";
import type { WorkEntry } from "../../src/models/types";

/**
 * 相談パネルの「相談を資料へ反映」（設計書6.72）。
 *
 * **どの作品の会話なのかを取り違えない**、が主題である（0.32.6のレビュー）。
 * 会話（`history`）は「最初から」でしか消えないので、作品を切り替えたり
 * 別の作品のファイルを開いたりしても残る。反映のときは作品を
 * `resolveContext()` から、会話を `history` から取っていたため、
 * **作品Aの相談で決めたことが、作品Bの承認待ちへ積まれる**余地があった。
 * 設定資料はGitで同期されるので、混ざったものは他の端末にも広がる。
 */

const applyCalls = vi.hoisted(
  () => [] as Array<{ workId: string; turns: number }>
);
vi.mock("../../src/features/chatSettingsSync", () => ({
  applyChatToSettings: async (
    work: { id: string },
    turns: readonly unknown[]
  ) => {
    applyCalls.push({ workId: work.id, turns: turns.length });
    return {
      staged: 1,
      creations: [],
      skipped: [],
      rejected: [],
      dropped: 0,
      unchanged: false,
      failed: false,
    };
  },
}));

/** 相談の記録はディスクへ書く。ここでは配線を見ないので黙らせる */
vi.mock("../../src/core/chatLog", () => ({
  appendChatLog: () => undefined,
  summarizeMaterials: () => [],
}));

vi.mock("../../src/core/logger", () => ({
  logFailure: () => undefined,
  logStep: () => undefined,
  logLine: () => undefined,
  useLogFile: () => undefined,
}));

vi.mock("../../src/features/aiConnectivity", () => ({
  confirmProviderReachable: async () => true,
  confirmPaidUsage: async () => true,
}));

const { WorkChatPanel } = await import("../../src/features/workChatPanel");

function work(id: string, title: string): WorkEntry {
  return {
    id,
    title,
    folderPath: `C:\\novels\\${id}`,
    registeredAt: "2026-09-05T00:00:00.000Z",
  };
}

const WORK_A = work("w_a", "氷の街");
const WORK_B = work("w_b", "灯台守の休日");

interface Posted {
  type: string;
  message?: string;
}

/** 画面へ送られたものを覗く作り物 */
function fakeView(posted: Posted[]) {
  return {
    visible: true,
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: (message: Posted) => {
        posted.push(message);
        return Promise.resolve(true);
      },
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  };
}

/** 相談のAI。JSONで一言返すだけ */
function fakeAi() {
  return {
    onDidChangeSelection: () => ({ dispose: () => undefined }),
    resolve: () => ({
      provider: {
        id: "ollama",
        displayName: "Ollama",
        isPaid: false,
        generate: async () => ({
          text: JSON.stringify({ reply: "17歳がよさそうです。" }),
        }),
      },
      model: "gemma4:e4b",
    }),
  };
}

interface Harness {
  panel: InstanceType<typeof WorkChatPanel>;
  posted: Posted[];
  /** どの作品の文脈で操作するかを切り替える */
  setWork(entry: WorkEntry): void;
}

function harness(): Harness {
  const posted: Posted[] = [];
  const registry = { list: () => [WORK_A, WORK_B] };
  const runner = { run: async () => undefined };
  const panel = new WorkChatPanel(
    registry as unknown as ConstructorParameters<typeof WorkChatPanel>[0],
    fakeAi() as unknown as ConstructorParameters<typeof WorkChatPanel>[1],
    runner as unknown as ConstructorParameters<typeof WorkChatPanel>[2]
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fakeView(posted) as any);

  // 検索は作品フォルダーを読む。ここでは相談の道筋だけを見たいので止める
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (panel as any).findRelated = async () => ({
    reference: [],
    searchTerms: [],
    materials: [],
  });

  let current = WORK_A;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (panel as any).resolveContext = async () => ({
    work: current,
    kind: "workOnly",
    filePath: current.folderPath,
    label: current.title,
    excerpt: "",
    truncated: false,
    fromSelection: false,
    reference: [],
  });

  return {
    panel,
    posted,
    setWork(entry) {
      current = entry;
    },
  };
}

/** 相談を1往復する（実際に会話を積むところまで通す） */
async function chat(h: Harness, question: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (h.panel as any).ask(question);
}

async function pressApply(h: Harness): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (h.panel as any).applyToSettings();
}

function notes(posted: Posted[]): string {
  return posted
    .filter((message) => message.type === "note" || message.type === "error")
    .map((message) => message.message ?? "")
    .join("\n");
}

beforeEach(() => {
  applyCalls.length = 0;
});

describe("会話は、それを積んだ作品にだけ反映する", () => {
  test("同じ作品なら、これまでどおり積む", async () => {
    const h = harness();
    await chat(h, "灯の年齢はどうしましょう");

    await pressApply(h);

    expect(applyCalls).toEqual([{ workId: "w_a", turns: 2 }]);
  });

  test("別の作品へ移ってから押しても、積まない", async () => {
    const h = harness();
    await chat(h, "灯の年齢はどうしましょう");

    h.setWork(WORK_B);
    await pressApply(h);

    expect(applyCalls).toEqual([]);
    // **どの作品の会話なのかを名指しで伝える。** 「できません」だけでは、
    // 作者は何を直せばよいのか分からない
    expect(notes(h.posted)).toContain("氷の街");
    // 押した手応えは必ず戻す（押せないままのボタンを残さない）
    expect(h.posted.map((m) => m.type)).toContain("applyToSettingsDone");
  });

  test("会話を消したあとは、次の作品の会話として積める", async () => {
    const h = harness();
    await chat(h, "灯の年齢はどうしましょう");

    // 「最初から」を押したのと同じ
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (h.panel as any).handle({ type: "clear" }, {
      postMessage: () => Promise.resolve(true),
    });
    h.setWork(WORK_B);
    await chat(h, "灯台守の名前を決めたいです");
    await pressApply(h);

    expect(applyCalls).toEqual([{ workId: "w_b", turns: 2 }]);
  });

  /**
   * 相談メモの保存も同じ取り違えを持っていた。**作品Aの会話が、作品Bの
   * `設定/相談メモ/` へ保存される**——同期されるので他の端末にも広がる。
   */
  test("相談メモの保存も、別の作品へは書かない", async () => {
    const h = harness();
    await chat(h, "灯の年齢はどうしましょう");

    h.setWork(WORK_B);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (h.panel as any).saveNote();

    expect(notes(h.posted)).toContain("氷の街");
    // 保存できたと言わない
    expect(notes(h.posted)).not.toContain("保存しました");
  });
});

/**
 * 画面は2つある（横のパネルと大きい画面）。**もう片方から押されたとき、
 * 黙って戻ると押せないままのボタンが残る**（0.32.6のレビュー）。
 */
describe("2つ目の画面から押されたとき", () => {
  test("実行中だと伝えて、ボタンを戻す", async () => {
    const h = harness();
    await chat(h, "灯の年齢はどうしましょう");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h.panel as any).applyingToSettings = true;
    h.posted.length = 0;

    await pressApply(h);

    expect(applyCalls).toEqual([]);
    expect(notes(h.posted)).toContain("実行中");
    expect(h.posted.map((m) => m.type)).toContain("applyToSettingsDone");
  });
});
